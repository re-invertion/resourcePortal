import { DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "../internal/deployment-execution.service";
import { StackApplyService } from "../internal/stack-apply.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

const renderedStack = "services:\n  web:\n    image: example/web:4\n    deploy:\n      replicas: 1\n";
const snapshot = JSON.stringify({ singleApps: [{ id: "app-1", name: "web", desiredReplicas: 1 }] });
const artifactSha256 = "a".repeat(64);

describe("RuntimeRestoreService exact artifact recovery", () => {
  it("re-applies the current successful persisted artifact for each deployed AppGroup", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "app-group-1",
        currentDeploymentVersion: 4,
        status: "Ready", runtimeState: "Running",
        tenant: { status: "Active", billing: null },
        singleApps: [{ id: "app-1", runtimeState: "Running", pendingDeletion: false }],
        deployments: [
          {
            id: "deployment-4",
            version: 4,
            status: DeploymentStatus.Succeeded,
            stackConfig: snapshot,
          },
        ],
      },
    ]);
    const applyStack = vi.fn().mockResolvedValue({
      stackName: "rp_app_group_1",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const ensureDeploymentArtifact = vi.fn().mockResolvedValue({
      renderedStack,
      sha256: artifactSha256,
    });

    const service = new RuntimeRestoreService(
      { appGroup: { findMany } } as unknown as PrismaService,
      { applyStack } as unknown as StackApplyService,
      { ensureDeploymentArtifact } as unknown as DeploymentExecutionService,
      { getState: vi.fn().mockResolvedValue({ enabled: false }) } as unknown as PlatformMaintenanceService,
    );

    await expect(service.reconcile()).resolves.toEqual({
      checked: 1,
      applied: 1,
      failed: 0,
      skipped: 0,
    });
    expect(ensureDeploymentArtifact).toHaveBeenCalledWith("deployment-4");
    expect(applyStack).toHaveBeenCalledWith({
      stackName: "rp_app_group_1",
      renderedStack,
      artifactSha256,
      appGroupId: "app-group-1",
    });
  });

  it("reports an unavailable/corrupt artifact as failed and a missing current deployment as skipped", async () => {
    const applyStack = vi.fn().mockResolvedValue({
      stackName: "rp_app_group_2",
      exitCode: 1,
      stdout: "",
      stderr: "apply failed",
    });
    const ensureDeploymentArtifact = vi
      .fn()
      .mockResolvedValueOnce({ renderedStack: "services: {}\n", sha256: artifactSha256 });
    const service = new RuntimeRestoreService(
      {
        appGroup: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "app-group-1",
              currentDeploymentVersion: 1,
              status: "Ready", runtimeState: "Running", tenant: { status: "Active", billing: null },
              singleApps: [{ id: "app-1", runtimeState: "Running", pendingDeletion: false }],
              deployments: [],
            },
            {
              id: "app-group-2",
              currentDeploymentVersion: 2,
              status: "Ready", runtimeState: "Running", tenant: { status: "Active", billing: null },
              singleApps: [{ id: "app-1", runtimeState: "Running", pendingDeletion: false }],
              deployments: [{ id: "deployment-2", version: 2, stackConfig: snapshot }],
            },
          ]),
        },
      } as unknown as PrismaService,
      { applyStack } as unknown as StackApplyService,
      { ensureDeploymentArtifact } as unknown as DeploymentExecutionService,
      { getState: vi.fn().mockResolvedValue({ enabled: false }) } as unknown as PlatformMaintenanceService,
    );

    await expect(service.reconcile()).resolves.toEqual({
      checked: 2,
      applied: 0,
      failed: 1,
      skipped: 1,
    });
  });
});
