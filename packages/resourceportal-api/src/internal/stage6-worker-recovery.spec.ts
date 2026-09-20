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
    renderedStackSha256: null,
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

describe("Stage 6 unified Worker deployment recovery", () => {
  it("reclaims an expired rollback only through its Operation-owned deployment id", async () => {
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
        findUnique: vi.fn(() => Promise.resolve(candidate)),
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
      deploymentEvent: { create: vi.fn(() => Promise.resolve({})) },
    };
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const recovery = recoveryService(prisma);

    const claimed = await recovery.claimDeploymentById(candidate.id, {
      workerId: "worker-b",
      leaseSeconds: 60,
    });

    expect(claimed.status).toBe(DeploymentStatus.RollingBack);
    expect(claimedStatus).toBe(DeploymentStatus.RollingBack);
    expect(tx.appGroupDeployment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not steal a deployment lease that is still live", async () => {
    const candidate = deployment({
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const tx = {
      appGroupDeployment: {
        findUnique: vi.fn(() => Promise.resolve(candidate)),
        updateMany: vi.fn(),
      },
      deploymentEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const recovery = recoveryService(prisma);

    await expect(
      recovery.claimDeploymentById(candidate.id, {
        workerId: "worker-b",
        leaseSeconds: 60,
      }),
    ).rejects.toThrow("Deployment is leased by another worker");
    expect(tx.appGroupDeployment.updateMany).not.toHaveBeenCalled();
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

  it("replays an incomplete rollback from the persisted target artifact and its digest", async () => {
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
      renderedStack: "services: target\n",
      renderedStackSha256: "b".repeat(64),
      rollbackTargetVersion: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
    });
    const artifact = {
      renderedStack: "services: target\n",
      sha256: "b".repeat(64),
    };
    const ensureDeploymentArtifact = vi.fn().mockResolvedValue(artifact);
    const renderStack = vi.fn(() => {
      throw new Error("rollback recovery must not re-render a persisted target");
    });
    const applyStack = vi.fn().mockResolvedValue({
      command: "docker stack deploy",
      exitCode: 0,
      stdout: "updated",
      stderr: "",
    });
    const inspectStackServices = vi.fn().mockResolvedValue([
      {
        name: "rp_app_group_1_api",
        image: "registry.example.test/team/api:2",
        runningReplicas: 1,
        desiredReplicas: 1,
      },
    ]);
    const waitForRollout = vi.fn().mockResolvedValue({
      success: true,
      message: "Rollout completed",
      details: "2/2 replicas",
    });
    const tx = {
      appGroupDeployment: {
        update: vi.fn().mockResolvedValue({
          ...failed,
          status: DeploymentStatus.RolledBack,
          phase: DeploymentPhase.Completed,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        }),
      },
      appGroup: { update: vi.fn().mockResolvedValue({}) },
      deploymentEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      appGroupDeployment: {
        findUnique: vi.fn().mockResolvedValue(failed),
        findFirst: vi.fn().mockResolvedValue(target),
      },
      deploymentEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const recovery = recoveryService(
      prisma,
      { ensureDeploymentArtifact, renderStack },
      { applyStack },
      { waitForRollout },
      { inspectStackServices },
    );

    const reconciled = await recovery.reconcileClaimedDeployment(
      failed.id,
      "worker-b",
    );

    expect(ensureDeploymentArtifact).toHaveBeenCalledWith(target.id);
    expect(renderStack).not.toHaveBeenCalled();
    expect(applyStack).toHaveBeenCalledWith({
      stackName: "rp_app_group_1",
      renderedStack: artifact.renderedStack,
      artifactSha256: artifact.sha256,
      appGroupId: "app-group-1",
    });
    expect(reconciled?.status).toBe(DeploymentStatus.RolledBack);
  });

});
