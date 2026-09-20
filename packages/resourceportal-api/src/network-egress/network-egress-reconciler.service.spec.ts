import { ConfigService } from "@nestjs/config";
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
