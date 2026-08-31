import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

function harness(results: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        DOCKER_CONTEXT: "default",
        NFS_GANESHA_SERVER: "10.0.0.15",
        NFS_GANESHA_VERSION: "4.1",
        STORAGE_REMOTE_VALIDATION_ENABLED: "true",
        STORAGE_REMOTE_VALIDATION_IMAGE: "alpine:3.20",
        STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: 1000,
      };
      return values[key] ?? fallback;
    }),
  };
  const runner = {
    run: vi.fn(() => Promise.resolve(results.shift() ?? { exitCode: 0, stdout: "", stderr: "" })),
  };
  const validator = new NfsRemoteAccessValidatorService(
    config as unknown as ConfigService,
    runner as unknown as StorageCommandRunnerService,
  );

  return { validator, runner };
}

describe("NfsRemoteAccessValidatorService", () => {
  it("quotes comma-separated local-driver NFS options for docker service create", async () => {
    const { validator, runner } = harness([
      { exitCode: 0, stdout: "node-a\nnode-b", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Complete 1 second ago|\nComplete 1 second ago|", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    await expect(validator.validate("/rp")).resolves.toEqual({
      ok: true,
      skipped: false,
      error: null,
    });

    const createCall = runner.run.mock.calls.find(
      ([program, args]) =>
        program === "docker" &&
        Array.isArray(args) &&
        args.includes("service") &&
        args.includes("create"),
    );
    expect(createCall).toBeDefined();
    const createArgs = createCall?.[1] as string[];
    const mountIndex = createArgs.indexOf("--mount");
    expect(createArgs[mountIndex + 1]).toBe(
      'type=volume,target=/probe,volume-driver=local,volume-opt=type=nfs,volume-opt=device=:/rp,"volume-opt=o=addr=10.0.0.15,rw,nfsvers=4.1"',
    );
  });

  it("validates the CephFS export through a temporary global Swarm service", async () => {
    const { validator, runner } = harness([
      { exitCode: 0, stdout: "node-a\nnode-b", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Complete 1 second ago|\nComplete 1 second ago|", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    await expect(validator.validate("/rp")).resolves.toEqual({
      ok: true,
      skipped: false,
      error: null,
    });

    expect(runner.run).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "--context",
        "default",
        "service",
        "create",
        "--mode",
        "global",
        "--mount",
      ]),
    );
    expect(runner.run).toHaveBeenLastCalledWith(
      "docker",
      expect.arrayContaining(["service", "rm"]),
    );
  });

  it("removes the probe service after a failed task", async () => {
    const { validator, runner } = harness([
      { exitCode: 0, stdout: "node-a", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Rejected 1 second ago|mount failed", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    const result = await validator.validate("/rp");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("NFS probe failed");
    expect(runner.run).toHaveBeenLastCalledWith(
      "docker",
      expect.arrayContaining(["service", "rm"]),
    );
  });

  it("reports an explicit skip when remote validation is disabled", async () => {
    const config = {
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "STORAGE_REMOTE_VALIDATION_ENABLED" ? "false" : fallback,
      ),
    };
    const runner = { run: vi.fn() };
    const validator = new NfsRemoteAccessValidatorService(
      config as unknown as ConfigService,
      runner as unknown as StorageCommandRunnerService,
    );

    await expect(validator.validate("/rp")).resolves.toEqual({
      ok: true,
      skipped: true,
      error: "Remote NFS validation disabled by configuration",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
