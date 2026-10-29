import { Prisma, RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { CapacityPreflightService } from "../capacity/capacity-preflight.service";
import type { OperationsRepository } from "../operations/operations.repository";
import type { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import type { PrismaService } from "../prisma/prisma.service";
import { AppGroupRuntimeOperationsService } from "./app-group-runtime-operations.service";

const tenantId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000002";
const appId = "00000000-0000-4000-8000-000000000003";
const actor = { id: "00000000-0000-4000-8000-000000000004", email: "tester@example.test", displayName: "Tester", status: "Active" } as never;

function fixture(existing: string | null) {
  const app = { id: appId, name: "worker", runtimeState: RuntimeState.Running, desiredReplicas: 1, pendingDeletion: false, cpu: new Prisma.Decimal(1), memoryBytes: BigInt(128 * 1024 * 1024) };
  const $queryRaw = vi.fn().mockResolvedValue(existing ? [{ id: existing }] : []);
  const tx = {
    appGroup: { findFirst: vi.fn().mockResolvedValue({ id: groupId, tenantId, runtimeState: RuntimeState.Running, singleApps: [app] }) },
    appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw,
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Test Tenant" }) },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    appGroup: { findFirst: vi.fn().mockResolvedValue({ id: groupId, tenantId,
      tenant: { status: "Active", billing: { balance: new Prisma.Decimal(10) } }, runtimeState: RuntimeState.Running }) },
    $transaction: vi.fn((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const createOperationInTransaction = vi.fn().mockResolvedValue({ id: "new-op" });
  const operations = { createOperationInTransaction } as unknown as OperationsRepository;
  const capacity = { lockRuntimeMutation: vi.fn().mockResolvedValue(undefined) } as unknown as CapacityPreflightService;
  const maintenance = { getState: vi.fn().mockResolvedValue({ enabled: false }) } as unknown as PlatformMaintenanceService;
  return { service: new AppGroupRuntimeOperationsService(prisma, capacity, operations, maintenance), createOperationInTransaction, $queryRaw };
}

describe("SingleApp restart idempotency (#365)", () => {
  it("returns existing queued operation rather than executing a second force restart", async () => {
    const { service, createOperationInTransaction, $queryRaw } = fixture("already-queued");
    await expect(service.restartSingleApp(tenantId, groupId, appId, actor)).resolves
      .toMatchObject({ operationId: "already-queued", deduplicated: true });
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(createOperationInTransaction).not.toHaveBeenCalled();
  });
  it("enqueues a new restart once with no side-effecting automatic replay", async () => {
    const { service, createOperationInTransaction } = fixture(null);
    await expect(service.restartSingleApp(tenantId, groupId, appId, actor)).resolves
      .toMatchObject({ operationId: "new-op" });
    expect(createOperationInTransaction).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ type: "SINGLE_APP_RESTART", maxAttempts: 1, tenantId, resourceId: appId }));
  });
});
