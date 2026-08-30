import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentWorkerService } from "./deployment-worker.service";

describe("Stage 6 deployment worker recovery", () => {
  it("reclaims an expired rollback without converting it to a deploy", async () => {
    const candidate = {
      id: "deployment-2",
      appGroupId: "app-group-1",
      version: 2,
      status: DeploymentStatus.RollingBack,
      phase: DeploymentPhase.RollingBack,
      stackConfig: JSON.stringify({
        appGroup: {
          id: "app-group-1",
          tenantId: "tenant-1",
          name: "example",
          runtimeState: "Running",
          runtimeDraftRevision: 2,
        },
        singleApps: [],
      }),
      renderedStack: null,
      renderedAt: null,
      sourceDraftRevision: 2,
      rollbackTargetVersion: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() - 60_000),
      heartbeatAt: new Date(Date.now() - 60_000),
      correlationId: "correlation-1",
      idempotencyKey: null,
      errorCode: "RolloutFailed",
      errorMessage: "rollout failed",
      createdBy: "user-1",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    };
    let claimedStatus: DeploymentStatus | undefined;

    const tx = {
      appGroupDeployment: {
        findFirst: vi.fn(
          (params: { where: { OR: Array<Record<string, unknown>> } }) => {
            const canRecoverRollback = params.where.OR.some(
              (condition) => condition.status === DeploymentStatus.RollingBack,
            );
            return Promise.resolve(canRecoverRollback ? candidate : null);
          },
        ),
        updateMany: vi.fn((params: { data: { status?: DeploymentStatus } }) => {
          claimedStatus = params.data.status;
          return Promise.resolve({ count: 1 });
        }),
        findUniqueOrThrow: vi.fn(() =>
          Promise.resolve({
            ...candidate,
            status: claimedStatus ?? candidate.status,
            leaseOwner: "worker-b",
          }),
        ),
      },
      deploymentEvent: {
        create: vi.fn(() => Promise.resolve({})),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const service = Reflect.construct(DeploymentWorkerService, [
      prisma,
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ]) as DeploymentWorkerService;

    const claimed = await service.claimNextDeployment({
      workerId: "worker-b",
      leaseSeconds: 60,
    });

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe(DeploymentStatus.RollingBack);
    expect(claimedStatus).toBe(DeploymentStatus.RollingBack);
  });
});
