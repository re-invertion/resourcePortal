import {
  AppGroupDeployment,
  DeploymentPhase,
  DeploymentStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentRecoveryService } from "./deployment-recovery.service";

function stackConfig(image = "registry.example.test/team/api:1") {
  return JSON.stringify({
    appGroup: {
      id: "app-group-1",
      tenantId: "tenant-1",
      name: "example",
      runtimeState: "Running",
      runtimeDraftRevision: 2,
    },
    singleApps: [
      {
        id: "single-app-1",
        name: "api",
        image,
        desiredReplicas: 2,
        runtimeState: "Running",
      },
    ],
  });
}

function deployment(
  overrides: Partial<AppGroupDeployment> = {},
): AppGroupDeployment {
  return {
    id: "deployment-2",
    appGroupId: "app-group-1",
    version: 2,
    status: DeploymentStatus.Deploying,
    phase: DeploymentPhase.ApplyingStack,
    stackConfig: stackConfig(),
    renderedStack: "services: {}",
    renderedAt: new Date(),
    sourceDraftRevision: 2,
    rollbackTargetVersion: null,
    leaseOwner: "worker-b",
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
    ...overrides,
  };
}

function recoveryService(
  prisma: object,
  worker: object = {},
  stackApply: object = {},
  stackRollout: object = {},
  stackRuntime: object = {},
) {
  return Reflect.construct(DeploymentRecoveryService, [
    prisma,
    worker,
    stackApply,
    stackRollout,
    stackRuntime,
  ]) as DeploymentRecoveryService;
}

describe("Stage 6 deployment worker recovery", () => {
  it("reclaims an expired rollback without converting it to a deploy", async () => {
    const candidate = deployment({
      status: DeploymentStatus.RollingBack,
      phase: DeploymentPhase.RollingBack,
      rollbackTargetVersion: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() - 60_000),
      heartbeatAt: new Date(Date.now() - 60_000),
      errorCode: "RolloutFailed",
      errorMessage: "rollout failed",
    });
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
    const recovery = recoveryService(prisma);

    const claimed = await recovery.claimNextDeployment({
      workerId: "worker-b",
      leaseSeconds: 60,
    });

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe(DeploymentStatus.RollingBack);
    expect(claimedStatus).toBe(DeploymentStatus.RollingBack);
  });

  it("reads Swarm state and skips duplicate stack apply when runtime is already in sync", async () => {
    const current = deployment();
    const applyRenderedStack = vi.fn(() => Promise.resolve(current));
    const inspectStackServices = vi.fn(() =>
      Promise.resolve([
        {
          name: "rp_app_group_1_api",
          image: "registry.example.test/team/api:1@sha256:abc123",
          desiredReplicas: 2,
        },
      ]),
    );
    const prisma = {
      appGroupDeployment: {
        findUnique: vi.fn(() => Promise.resolve(current)),
      },
      deploymentEvent: {
        create: vi.fn(() => Promise.resolve({})),
      },
    };
    const recovery = recoveryService(
      prisma,
      { applyRenderedStack },
      {},
      {},
      { inspectStackServices },
    );

    const reconciled = await recovery.reconcileClaimedDeployment(
      current.id,
      "worker-b",
    );

    expect(inspectStackServices).toHaveBeenCalledWith("rp_app_group_1");
    expect(applyRenderedStack).not.toHaveBeenCalled();
    expect(reconciled?.phase).toBe(DeploymentPhase.ApplyingStack);
  });

  it("defers recovery without applying when Swarm state cannot be read", async () => {
    const current = deployment();
    const applyRenderedStack = vi.fn(() => Promise.resolve(current));
    const inspectStackServices = vi.fn(() => Promise.resolve(null));
    let releasedLease:
      | { leaseOwner: string | null; heartbeatAt: Date | null }
      | undefined;
    const releaseLease = vi.fn(
      (params: {
        data: {
          leaseOwner: string | null;
          leaseExpiresAt: Date | null;
          heartbeatAt: Date | null;
        };
      }) => {
        releasedLease = {
          leaseOwner: params.data.leaseOwner,
          heartbeatAt: params.data.heartbeatAt,
        };
        return Promise.resolve({ count: 1 });
      },
    );
    const tx = {
      appGroupDeployment: {
        updateMany: releaseLease,
      },
      deploymentEvent: {
        create: vi.fn(() => Promise.resolve({})),
      },
    };
    const prisma = {
      appGroupDeployment: {
        findUnique: vi.fn(() => Promise.resolve(current)),
      },
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const recovery = recoveryService(
      prisma,
      { applyRenderedStack },
      {},
      {},
      { inspectStackServices },
    );

    const reconciled = await recovery.reconcileClaimedDeployment(
      current.id,
      "worker-b",
    );

    expect(reconciled).toBeNull();
    expect(applyRenderedStack).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(releasedLease).toEqual({
      leaseOwner: null,
      heartbeatAt: null,
    });
  });

  it("finishes an already-applied rollback without running docker stack deploy again", async () => {
    const failed = deployment({
      status: DeploymentStatus.RollingBack,
      phase: DeploymentPhase.RollingBack,
      rollbackTargetVersion: 1,
      errorCode: "RolloutFailed",
      errorMessage: "rollout failed",
    });
    const target = deployment({
      id: "deployment-1",
      version: 1,
      status: DeploymentStatus.Succeeded,
      phase: DeploymentPhase.Completed,
      renderedStack: "services: target",
      rollbackTargetVersion: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
    });
    const applyStack = vi.fn(() =>
      Promise.resolve({
        command: "docker stack deploy",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    );
    const inspectStackServices = vi.fn(() =>
      Promise.resolve([
        {
          name: "rp_app_group_1_api",
          image: "registry.example.test/team/api:1",
          desiredReplicas: 2,
        },
      ]),
    );
    const waitForRollout = vi.fn(() =>
      Promise.resolve({
        success: true,
        message: "Rollout completed",
        details: "2/2 replicas",
      }),
    );
    const tx = {
      singleApp: {
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      appGroupDeployment: {
        update: vi.fn(() =>
          Promise.resolve({
            ...failed,
            status: DeploymentStatus.RolledBack,
            phase: DeploymentPhase.Completed,
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          }),
        ),
      },
      appGroup: {
        update: vi.fn(() => Promise.resolve({})),
      },
      deploymentEvent: {
        create: vi.fn(() => Promise.resolve({})),
      },
    };
    const prisma = {
      appGroupDeployment: {
        findUnique: vi.fn(() => Promise.resolve(failed)),
        findFirst: vi.fn(() => Promise.resolve(target)),
      },
      deploymentEvent: {
        create: vi.fn(() => Promise.resolve({})),
      },
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const recovery = recoveryService(
      prisma,
      {},
      { applyStack },
      { waitForRollout },
      { inspectStackServices },
    );

    const reconciled = await recovery.reconcileClaimedDeployment(
      failed.id,
      "worker-b",
    );

    expect(inspectStackServices).toHaveBeenCalledWith("rp_app_group_1");
    expect(applyStack).not.toHaveBeenCalled();
    expect(waitForRollout).toHaveBeenCalledTimes(1);
    expect(reconciled?.status).toBe(DeploymentStatus.RolledBack);
  });
});
