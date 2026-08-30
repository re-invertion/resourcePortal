import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentWorkerService } from "./deployment-worker.service";

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    appGroupId: "22222222-2222-4222-8222-222222222222",
    version: 7,
    status: DeploymentStatus.Pending,
    phase: DeploymentPhase.Validating,
    stackConfig: JSON.stringify({
      appGroup: {
        id: "22222222-2222-4222-8222-222222222222",
        tenantId: "33333333-3333-4333-8333-333333333333",
        name: "example",
        runtimeState: "Running",
        runtimeDraftRevision: 1,
      },
      singleApps: [],
    }),
    renderedStack: null,
    renderedAt: null,
    sourceDraftRevision: 1,
    rollbackTargetVersion: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    correlationId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: null,
    errorCode: null,
    errorMessage: null,
    createdBy: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date("2026-08-30T12:00:00Z"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function workerService(prisma: object) {
  return Reflect.construct(DeploymentWorkerService, [
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
}

function appGroup() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    name: "example",
    tenant: { name: "tenant" },
  };
}

describe("Stage 12 deployment system audit", () => {
  it("records appgroup.deploy.started once when a pending deployment is first claimed", async () => {
    const candidate = deployment();
    const claimed = deployment({
      status: DeploymentStatus.Deploying,
      leaseOwner: "worker-1",
      startedAt: new Date("2026-08-30T12:01:00Z"),
    });
    const auditCreate = vi.fn(() => Promise.resolve({}));
    const tx = {
      appGroupDeployment: {
        findFirst: vi.fn(() => Promise.resolve(candidate)),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        findUniqueOrThrow: vi.fn(() => Promise.resolve(claimed)),
      },
      deploymentEvent: { create: vi.fn(() => Promise.resolve({})) },
      appGroup: { findUniqueOrThrow: vi.fn(() => Promise.resolve(appGroup())) },
      auditLogEntry: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const service = workerService(prisma);

    await service.claimNextDeployment({ workerId: "worker-1", leaseSeconds: 60 });

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: appGroup().tenantId,
        tenantName: "tenant",
        actor: "system",
        actorName: "Deployment Worker",
        action: "appgroup.deploy.started",
        resourceType: "AppGroup",
        resourceId: appGroup().id,
        resourceName: appGroup().name,
        result: "Success",
        correlationId: candidate.correlationId,
      }),
    });
  });

  it("records appgroup.deploy.failed when a claimed deployment fails", async () => {
    const active = deployment({
      status: DeploymentStatus.Deploying,
      leaseOwner: "worker-1",
      startedAt: new Date("2026-08-30T12:01:00Z"),
    });
    const failed = deployment({
      status: DeploymentStatus.Failed,
      leaseOwner: null,
      errorCode: "RuntimeFailed",
      errorMessage: "rollout failed",
      completedAt: new Date("2026-08-30T12:02:00Z"),
    });
    const auditCreate = vi.fn(() => Promise.resolve({}));
    const tx = {
      appGroupDeployment: { update: vi.fn(() => Promise.resolve(failed)) },
      deploymentEvent: { create: vi.fn(() => Promise.resolve({})) },
      appGroup: { findUniqueOrThrow: vi.fn(() => Promise.resolve(appGroup())) },
      auditLogEntry: { create: auditCreate },
    };
    const prisma = {
      appGroupDeployment: { findUnique: vi.fn(() => Promise.resolve(active)) },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const service = workerService(prisma);

    await service.failDeployment(active.id, {
      workerId: "worker-1",
      errorCode: "RuntimeFailed",
      errorMessage: "rollout failed",
    });

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "system",
        actorName: "Deployment Worker",
        action: "appgroup.deploy.failed",
        resourceId: active.appGroupId,
        result: "Failed",
        errorCode: "RuntimeFailed",
        errorMessage: "rollout failed",
        correlationId: active.correlationId,
      }),
    });
  });
});
