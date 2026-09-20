import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { DeploymentExecutionService } from "./deployment-execution.service";

describe("explicit rollback completion", () => {
  it("marks the rollback deployment RolledBack and restores currentDeploymentVersion", async () => {
    const deployment = {
      id: "deployment-3",
      appGroupId: "app-group-1",
      version: 3,
      status: DeploymentStatus.Deploying,
      phase: DeploymentPhase.WaitingForRollout,
      stackConfig: JSON.stringify({
        appGroup: {
          id: "app-group-1",
          tenantId: "tenant-1",
          name: "group",
          runtimeState: "Running",
          runtimeDraftRevision: 7,
        },
        singleApps: [
          {
            id: "app-1",
            name: "web",
            image: "nginx:alpine",
            desiredReplicas: 1,
            runtimeState: "Running",
          },
        ],
      }),
      renderedStack: "services: {}",
      renderedStackSha256: "sha",
      renderedAt: new Date(),
      sourceDraftRevision: 7,
      rollbackTargetVersion: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
      correlationId: "correlation-1",
      idempotencyKey: null,
      errorCode: null,
      errorMessage: null,
      createdBy: "user-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    };

    const deploymentUpdate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...deployment, ...args.data }),
    );
    const appGroupUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      singleApp: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
      appGroup: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ runtimeDraftRevision: 7 }),
        update: appGroupUpdate,
      },
      appGroupDeployment: {
        update: deploymentUpdate,
      },
      deploymentEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      appGroupDeployment: {
        findUnique: vi.fn().mockResolvedValue(deployment),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const rollout = {
      waitForRollout: vi.fn().mockResolvedValue({
        success: true,
        message: "Rollout completed",
        details: "rp_app_group_1_web: 1/1 replicas",
      }),
    };

    const service = new DeploymentExecutionService(
      prisma,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      rollout as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const result = await (
      service as unknown as {
        waitForRollout(
          deploymentId: string,
          workerId: string,
        ): Promise<{
          status: DeploymentStatus;
          rollbackTargetVersion: number | null;
        }>;
      }
    ).waitForRollout(deployment.id, "worker-a");

    expect(result.status).toBe(DeploymentStatus.RolledBack);
    expect(result.rollbackTargetVersion).toBe(1);
    const updateArgs = deploymentUpdate.mock.calls[0]?.[0];
    expect(updateArgs?.data.status).toBe(DeploymentStatus.RolledBack);
    expect(updateArgs?.data.phase).toBe(DeploymentPhase.Completed);
    expect(appGroupUpdate).toHaveBeenCalledWith({
      where: { id: "app-group-1" },
      data: {
        currentDeploymentVersion: 1,
        hasPendingChanges: true,
      },
    });
  });
});
