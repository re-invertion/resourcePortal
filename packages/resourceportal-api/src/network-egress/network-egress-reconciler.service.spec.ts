import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EGRESS_POLICY, encodeEgressPolicy } from "./egress-guard.logic";
import { NetworkEgressReconcilerService } from "./network-egress-reconciler.service";
import type { NetworkEgressService } from "./network-egress.service";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

class TestNetworkEgressReconcilerService extends NetworkEgressReconcilerService {
  readonly runDockerMock = vi.fn(
    (...call: [string[]]): Promise<CommandResult> => {
      void call;
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  );

  protected override runDocker(args: string[]) {
    return this.runDockerMock(args);
  }
}

function fixture() {
  const snapshot = { ...DEFAULT_EGRESS_POLICY, revision: 3 };
  const egress = {
    policySnapshot: vi.fn().mockResolvedValue(snapshot),
  };
  const config = { get: vi.fn((_key: string, fallback?: string) => fallback) };
  const service = new TestNetworkEgressReconcilerService(
    egress as unknown as NetworkEgressService,
    config as unknown as ConfigService,
  );
  return { service, runDocker: service.runDockerMock, snapshot };
}

describe("NetworkEgressReconcilerService", () => {
  it("does not restart the global guard when the desired snapshot is already attached", async () => {
    const { service, runDocker, snapshot } = fixture();
    runDocker.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([
        `RESOURCEPORTAL_EGRESS_POLICY_B64=${encodeEgressPolicy(snapshot)}`,
      ]),
      stderr: "",
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      changed: false,
      recoveredMissingSnapshot: false,
      revision: 3,
      enabled: true,
    });
    expect(runDocker).toHaveBeenCalledTimes(1);
  });

  it("updates only the egress guard environment when the desired revision changes", async () => {
    const { service, runDocker, snapshot } = fixture();
    runDocker
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(["NODE_ENV=production"]),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "updated", stderr: "" });

    await expect(service.reconcile()).resolves.toMatchObject({
      changed: true,
      recoveredMissingSnapshot: true,
      revision: 3,
    });
    const updateArgs = runDocker.mock.calls[1]?.[0] ?? [];
    expect(updateArgs.slice(0, 2)).toEqual(["service", "update"]);
    expect(updateArgs).toContain(
      `RESOURCEPORTAL_EGRESS_POLICY_B64=${encodeEgressPolicy(snapshot)}`,
    );
    expect(updateArgs.at(-1)).toBe("resourceportal-control-plane_egress-guard");
  });
});

describe("egress snapshot restoration across guard restarts (#217)", () => {
  it("reports missing policy and successful reattachment from the worker side", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { service, runDocker } = fixture();
      runDocker
        .mockResolvedValueOnce({ exitCode: 0, stdout: '["NODE_ENV=production"]', stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "updated", stderr: "" });

      await expect(service.reconcile()).resolves.toMatchObject({
        changed: true, recoveredMissingSnapshot: true,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        "EGRESS_POLICY_SNAPSHOT_MISSING status=degraded source=worker",
      ));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        "EGRESS_POLICY_SNAPSHOT_RESTORED status=reattached source=worker",
      ));
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("replaces malformed snapshot and records restoration, not just missing variable", async () => {
    const { service, runDocker } = fixture();
    runDocker
      .mockResolvedValueOnce({
        exitCode: 0, stdout: '["RESOURCEPORTAL_EGRESS_POLICY_B64=invalid"]', stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "updated", stderr: "" });

    await expect(service.reconcile()).resolves.toMatchObject({
      changed: true, recoveredMissingSnapshot: true,
    });
    expect(runDocker.mock.calls[1]?.[0]).toContain("--env-rm");
  });

  it("never claims recovery when Docker refuses to reattach the snapshot", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { service, runDocker } = fixture();
      runDocker
        .mockResolvedValueOnce({ exitCode: 0, stdout: "[]", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "update refused" });

      await expect(service.reconcile()).rejects.toThrow("update refused");
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining(
        "EGRESS_POLICY_SNAPSHOT_RESTORED",
      ));
    } finally {
      log.mockRestore();
    }
  });

  it("does not misclassify a routine valid policy revision as outage recovery", async () => {
    const { service, runDocker, snapshot } = fixture();
    runDocker
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          `RESOURCEPORTAL_EGRESS_POLICY_B64=${encodeEgressPolicy({ ...snapshot, revision: 2 })}`,
        ]),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "updated", stderr: "" });

    await expect(service.reconcile()).resolves.toMatchObject({
      changed: true, recoveredMissingSnapshot: false,
    });
    expect(runDocker.mock.calls[1]?.[0]).toContain("--env-rm");
  });
});
