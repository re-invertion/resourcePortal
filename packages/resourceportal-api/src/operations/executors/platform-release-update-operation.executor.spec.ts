import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { StorageCommandRunnerService } from "../../storage-backends/storage-command-runner.service";
import { PlatformReleaseUpdateOperationExecutor } from "./platform-release-update-operation.executor";
import type { OperationRecord } from "../operation.types";

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
      resourceId: "0.2.67",
      result: { targetVersion: "0.2.67", status: "updater-completed" },
    });

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
    expect(run).toHaveBeenLastCalledWith(
      "docker",
      ["wait", "resourceportal-updater-11111111-1111-4111-8111-111111111111"],
      30 * 60 * 1000,
    );
  });

  it("finishes immediately after a restarted target-version Worker reclaims the operation", async () => {
    const run = vi.fn();
    const config = { get: vi.fn((key: string) => key === "INSTALLER_VERSION" ? "0.2.67" : undefined) };
    const executor = new PlatformReleaseUpdateOperationExecutor(
      { run } as unknown as StorageCommandRunnerService,
      config as unknown as ConfigService,
    );

    await expect(executor.execute(operation())).resolves.toMatchObject({
      result: {
        targetVersion: "0.2.67",
        currentVersion: "0.2.67",
        status: "already-current",
      },
    });
    expect(run).not.toHaveBeenCalled();
  });
});
