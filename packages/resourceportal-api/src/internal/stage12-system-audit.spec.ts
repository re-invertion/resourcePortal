import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { DeploymentAuditService } from "./deployment-audit.service";

type AuditCreateInput = {
  data: Record<string, unknown>;
};

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    appGroupId: "22222222-2222-4222-8222-222222222222",
    version: 7,
    status: DeploymentStatus.Deploying,
    phase: DeploymentPhase.Validating,
    stackConfig: null,
    renderedStack: null,
    renderedAt: null,
    sourceDraftRevision: 1,
    rollbackTargetVersion: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-30T12:05:00Z"),
    heartbeatAt: new Date("2026-08-30T12:01:00Z"),
    correlationId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: null,
    errorCode: null,
    errorMessage: null,
    createdBy: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date("2026-08-30T12:00:00Z"),
    startedAt: new Date("2026-08-30T12:01:00Z"),
    completedAt: null,
    appGroup: {
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "33333333-3333-4333-8333-333333333333",
      name: "example",
      tenant: { name: "tenant" },
    },
    ...overrides,
  };
}

function serviceFor(currentDeployment: ReturnType<typeof deployment>) {
  const auditCreate = vi.fn((input: AuditCreateInput) => Promise.resolve(input));
  const auditFindFirst = vi.fn((input: unknown) => {
    void input;
    return Promise.resolve<{ id: string } | null>(null);
  });
  const prisma = {
    appGroupDeployment: {
      findUnique: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve(currentDeployment);
      }),
    },
    auditLogEntry: {
      findFirst: auditFindFirst,
      create: auditCreate,
    },
  };

  return {
    auditCreate,
    auditFindFirst,
    service: new DeploymentAuditService(prisma as unknown as PrismaService),
  };
}

describe("Stage 12 deployment system audit", () => {
  it("records appgroup.deploy.started with the canonical system actor", async () => {
    const current = deployment();
    const { auditCreate, service } = serviceFor(current);

    await service.recordStarted(current.id);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      tenantId: current.appGroup.tenantId,
      tenantName: "tenant",
      actor: "system",
      actorName: "Deployment Worker",
      action: "appgroup.deploy.started",
      resourceType: "AppGroup",
      resourceId: current.appGroup.id,
      resourceName: current.appGroup.name,
      result: "Success",
      correlationId: current.correlationId,
    });
  });

  it("deduplicates deployment lifecycle events by tenant, correlationId and action", async () => {
    const current = deployment();
    const { auditCreate, auditFindFirst, service } = serviceFor(current);
    auditFindFirst.mockResolvedValueOnce({ id: "existing-audit-entry" });

    await service.recordStarted(current.id);

    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("records appgroup.deploy.failed for failed and rolled-back terminal deployments", async () => {
    const current = deployment({
      status: DeploymentStatus.RolledBack,
      phase: DeploymentPhase.Completed,
      rollbackTargetVersion: 6,
      errorCode: "RolloutFailed",
      errorMessage: "rollout failed; rollback succeeded",
      completedAt: new Date("2026-08-30T12:02:00Z"),
    });
    const { auditCreate, service } = serviceFor(current);

    await service.recordOutcome(current.id);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "system",
      actorName: "Deployment Worker",
      action: "appgroup.deploy.failed",
      resourceId: current.appGroupId,
      result: "Failed",
      errorCode: "RolloutFailed",
      errorMessage: "rollout failed; rollback succeeded",
      correlationId: current.correlationId,
      changes: {
        deploymentId: current.id,
        rollbackTargetVersion: 6,
        status: DeploymentStatus.RolledBack,
      },
    });
  });
});
