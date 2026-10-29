import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { StorageCommandRunnerService } from "../../storage-backends/storage-command-runner.service";
import { PlatformReleaseUpdateOperationExecutor } from "./platform-release-update-operation.executor";
import type { OperationRecord } from "../operation.types";
import { OperationsWorkerService } from "../operations-worker.service";
import type { OperationsRepository } from "../operations.repository";
import type { OperationExecutorRegistry } from "../operation-executor-registry";

function operation(): OperationRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "PLATFORM_RELEASE_UPDATE",
    tenantId: null,
    resourceType: "PlatformRelease",
    resourceId: null,
    status: "Running",
    phase: null,
    createdBy: "user1",
    createdByEmail: "admin@example.test",
    createdByDisplayName: "Admin",
    input: {
      targetVersion: "0.2.67",
      manifestUrl: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
    },
    result: null,
    idempotencyKey: "platform-release-update:0.2.67",
    attempt: 1,
    maxAttempts: 3,
    nextAttemptAt: new Date(),
    leaseOwner: "worker",
    leaseExpiresAt: new Date(),
    heartbeatAt: new Date(),
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe("PlatformReleaseUpdateOperationExecutor", () => {
  it("starts an independent updater container and waits for its exit code", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "container-id", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0", stderr: "" });
    const values: Record<string, string> = {
      INSTALLER_VERSION: "0.2.66",
      RESOURCEPORTAL_RUNTIME_IMAGE: "ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      RESOURCE_STORAGE_BASE_PATH: "/srv/resource-portal/storage",
      RESOURCE_STORAGE_QUOTA_DEVICE: "/dev/vdb",
    };
    const config = { get: vi.fn((key: string) => values[key]) };
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      config as unknown as ConfigService,
    );

    await expect(executor.execute(operation())).resolves.toMatchObject({
      result: { targetVersion: "0.2.67", status: "updater-completed" },
    });
    // Operation.resourceId is typed as UUID in PostgreSQL; semver can never
    // be passed into the worker's terminal markSucceeded query.
    const dockerRun = run.mock.calls[1];
    expect(dockerRun?.[0]).toBe("docker");
    expect(dockerRun?.[1]).toEqual(expect.arrayContaining([
      "run",
      "-d",
      "--name",
      "resourceportal-updater-11111111-1111-4111-8111-111111111111",
      "-v",
      "/etc/resourceportal:/etc/resourceportal",
      "-v",
      "/var/lib/resourceportal:/var/lib/resourceportal",
    ]));
    expect(dockerRun?.[1]).toEqual(expect.arrayContaining([
      "RP_TARGET_CONTAINER=resourceportal-updater-11111111-1111-4111-8111-111111111111-target",
      "RP_UPDATER_STORAGE_BASE=/srv/resource-portal/storage",
      "RP_UPDATER_STORAGE_DEVICE=/dev/vdb",
    ]));
    expect((dockerRun?.[1] as string[]).at(-1)).toContain("scripts/installer/target-upgrade.sh");
    expect((dockerRun?.[1] as string[]).at(-1)).not.toContain("resourceportal-install.sh --mode upgrade");
    expect(run).toHaveBeenLastCalledWith(
      "docker",
      ["wait", "resourceportal-updater-11111111-1111-4111-8111-111111111111"],
      30 * 60 * 1000,
    );
  });

  it("after a Worker restart verifies the completed updater before returning UUID-safe success", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "exited 0", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0", stderr: "" });
    const config = { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) };
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      config as unknown as ConfigService,
    );

    const completed = await executor.execute(operation());
    expect(completed).toMatchObject({
      result: { targetVersion: "0.2.67", status: "updater-completed" },
    });
    expect(completed).not.toHaveProperty("resourceId");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "docker", [
      "inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.State.FinishedAt}}",
      "resourceportal-updater-11111111-1111-4111-8111-111111111111",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, "docker", [
      "wait", "resourceportal-updater-11111111-1111-4111-8111-111111111111",
    ], 30 * 60 * 1000);
  });

  it("persists Succeeded after restart without attempting to cast a release version to UUID", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "exited 0", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0", stderr: "" });
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) } as unknown as ConfigService,
    );
    const claimed = { ...operation(), leaseOwner: "production-worker", attempt: 2 };
    const markSucceeded = vi.fn((
      _operationId: string, _workerId: string, _result: unknown, resourceId: string | null | undefined,
    ) => {
      // Emulate the PostgreSQL UUID column's rejection of a semantic version.
      if (resourceId !== null && resourceId !== undefined &&
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(resourceId)) {
        throw new Error('invalid input syntax for type uuid: "' + resourceId + '"');
      }
      return Promise.resolve({ ...claimed, status: "Succeeded" as const });
    });
    const repository = {
      failExhaustedOperations: vi.fn().mockResolvedValue([]),
      failStaleQueuedRestarts: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValue(claimed),
      appendEvent: vi.fn().mockResolvedValue(null),
      heartbeat: vi.fn().mockResolvedValue(claimed),
      markSucceeded,
    };
    const worker = new OperationsWorkerService(
      repository as unknown as OperationsRepository,
      { resolve: vi.fn().mockReturnValue(executor) } as unknown as OperationExecutorRegistry,
    );

    await expect(worker.processNext("production-worker", 300))
      .resolves.toMatchObject({ status: "Succeeded" });
    expect(markSucceeded).toHaveBeenCalledWith(
      claimed.id, "production-worker",
      expect.objectContaining({ targetVersion: "0.2.67", status: "updater-completed" }),
      undefined, "Succeeded",
    );
    expect(repository.appendEvent).toHaveBeenCalledWith(
      claimed.id, expect.objectContaining({ event: "ExecutionSucceeded" }),
    );
  });

  it("does not mark success when the target API is running but its updater is still active", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "running 0", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 124, stdout: "", stderr: "command terminated by SIGTERM" });
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) } as unknown as ConfigService,
    );
    await expect(executor.execute(operation())).rejects.toMatchObject({
      code: "PlatformUpdateInProgress", retryable: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the new-version Worker cannot find its own updater evidence", async () => {
    const run = vi.fn().mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" });
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) } as unknown as ConfigService,
    );
    await expect(executor.execute(operation())).rejects.toMatchObject({
      code: "PlatformUpdaterEvidenceMissing", retryable: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the old updater exited with failure after Worker restart", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "exited 1", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "target upgrade aborted", stderr: "" });
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) } as unknown as ConfigService,
    );
    await expect(executor.execute(operation())).rejects.toMatchObject({
      code: "PlatformUpdateFailed", retryable: false,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toEqual(["logs", "--tail", "200",
      "resourceportal-updater-11111111-1111-4111-8111-111111111111"]);
  });
});

describe("platform release provenance restrictions (#227)", () => {
  it.each([
    "https://github.com/attacker/evil/releases/download/v0.2.67/resourceportal-release-manifest.json",
    "https://github.com/re-invertion/other/releases/download/v0.2.67/resourceportal-release-manifest.json",
    "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.66/resourceportal-release-manifest.json",
    "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json?bad=1",
    "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/../resourceportal-release-manifest.json",
    "https://github.com.evil.example/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
  ])("rejects non-canonical release manifest %s before starting privileged updater", async (manifestUrl) => {
    const run = vi.fn();
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.66" : undefined) } as unknown as ConfigService,
    );
    await expect(executor.execute({
      ...operation(), input: { targetVersion: "0.2.67", manifestUrl },
    })).rejects.toThrow("InvalidOperationInput:manifestUrl");
    expect(run).not.toHaveBeenCalled();
  });
});


describe("explicit platform update retry (#366)", () => {
  const base = "resourceportal-updater-11111111-1111-4111-8111-111111111111";
  const values: Record<string, string> = {
    INSTALLER_VERSION: "0.2.66",
    RESOURCEPORTAL_RUNTIME_IMAGE: "ghcr.io/re-invertion/resourceportal-api@sha256:" + "a".repeat(64),
    RESOURCE_STORAGE_BASE_PATH: "/srv/resource-portal/storage",
    RESOURCE_STORAGE_QUOTA_DEVICE: "/dev/vdb",
  };
  it("starts a fresh stable container for a retry made after the old updater failed", async () => {
    const startedAt = new Date("2026-10-28T21:00:00Z");
    const name = `${base}-retry-${startedAt.getTime()}`;
    const run = vi.fn<(command: string, args: string[], timeout?: number) => Promise<{exitCode: number; stdout: string; stderr: string}>>().mockImplementation((_command, args) => {
      if (args[0] === "inspect") return Promise.resolve(args.at(-1) === base
        ? { exitCode: 0, stdout: "exited 1 2026-10-28T20:00:00Z", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not found" });
      return Promise.resolve({ exitCode: 0, stdout: args[0] === "wait" ? "0" : "container-id", stderr: "" });
    });
    const executor = new PlatformReleaseUpdateOperationExecutor({ run } as unknown as StorageCommandRunnerService,
      { get: (key: string) => values[key] } as unknown as ConfigService);
    await expect(executor.execute({ ...operation(), startedAt })).resolves.toMatchObject({ result: { status: "updater-completed" } });
    expect(run).toHaveBeenCalledWith("docker", expect.arrayContaining(["run", "--name", name]), 120000);
    expect(run).toHaveBeenLastCalledWith("docker", ["wait", name], 30 * 60 * 1000);
    expect(run.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  });
  it("reconnects to the same retry container after a Worker restart", async () => {
    const startedAt = new Date("2026-10-28T21:00:00Z");
    const name = `${base}-retry-${startedAt.getTime()}`;
    const run = vi.fn<(command: string, args: string[], timeout?: number) => Promise<{exitCode: number; stdout: string; stderr: string}>>().mockImplementation((_command, args) => Promise.resolve({ exitCode: 0, stderr: "",
      stdout: args[0] === "wait" ? "0" : args.at(-1) === base ? "exited 1 2026-10-28T20:00:00Z" : "running 0 0001-01-01T00:00:00Z" }));
    const executor = new PlatformReleaseUpdateOperationExecutor({ run } as unknown as StorageCommandRunnerService,
      { get: (key: string) => values[key] } as unknown as ConfigService);
    await expect(executor.execute({ ...operation(), startedAt, attempt: 2 })).resolves.toBeDefined();
    expect(run).toHaveBeenLastCalledWith("docker", ["wait", name], 30 * 60 * 1000);
    expect(run.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
  });
  it("does not replay a failed updater from the same execution or expose signed URLs", async () => {
    const run = vi.fn<(command: string, args: string[], timeout?: number) => Promise<{exitCode: number; stdout: string; stderr: string}>>().mockImplementation((_command, args) => Promise.resolve({ exitCode: 0, stderr: "",
      stdout: args[0] === "inspect" ? "exited 1 2026-10-28T22:00:00Z" : "Get https://pkg-containers.githubusercontent.com/blob?sig=secret: timeout awaiting response headers" }));
    const executor = new PlatformReleaseUpdateOperationExecutor({ run } as unknown as StorageCommandRunnerService,
      { get: (key: string) => values[key] } as unknown as ConfigService);
    const failure = executor.execute({ ...operation(), startedAt: new Date("2026-10-28T21:00:00Z") });
    await expect(failure).rejects.toMatchObject({ code: "PlatformUpdateFailed", retryable: false });
    await expect(failure).rejects.not.toThrow("sig=secret");
    expect(run.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
  });
});
