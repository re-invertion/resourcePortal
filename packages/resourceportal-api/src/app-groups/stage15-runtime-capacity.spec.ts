import { Prisma, RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CapacityPreflightService } from "../capacity/capacity-preflight.service";
import { OperationsRepository } from "../operations/operations.repository";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppGroupRuntimeOperationsService } from "./app-group-runtime-operations.service";

const actor = (id: string) =>
  ({ id, email: `${id}@example.com`, displayName: id, status: "Active" }) as never;

function operations() {
  const createOperationInTransaction = vi.fn().mockResolvedValue({
    id: "operation-1",
  });
  return {
    repository: { createOperationInTransaction } as unknown as OperationsRepository,
    createOperationInTransaction,
  };
}

const maintenance = {
  getState: vi.fn().mockResolvedValue({ enabled: false }),
} as unknown as PlatformMaintenanceService;

describe("v0.2 runtime capacity boundary", () => {
  it("does not persist Running or enqueue runtime work when capacity rejects AppGroup start", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000101";
    const tenantId = "00000000-0000-0000-0000-000000000201";
    const persistedUpdate = vi.fn();
    const tx = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: 1,
          singleApps: [],
        }),
        update: persistedUpdate,
      },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          tenant: {
            status: "Active",
            billing: { balance: new Prisma.Decimal(10) },
          },
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const lockRuntimeMutation = vi.fn().mockResolvedValue(undefined);
    const admitRuntimeStart = vi.fn().mockResolvedValue({
      success: false,
      errorCode: "InsufficientCapacity",
      message: "Insufficient platform cpu capacity",
    });
    const capacity = {
      lockRuntimeMutation,
      admitRuntimeStart,
    } as unknown as CapacityPreflightService;
    const operationFixture = operations();
    const service = new AppGroupRuntimeOperationsService(
      prisma,
      capacity,
      operationFixture.repository,
      maintenance,
    );

    await expect(
      service.startAppGroup(tenantId, appGroupId, actor("user-1")),
    ).rejects.toMatchObject({ response: { code: "InsufficientCapacity" } });

    expect(lockRuntimeMutation).toHaveBeenCalledWith(tx);
    expect(admitRuntimeStart).toHaveBeenCalledWith(tx, { appGroupId });
    expect(persistedUpdate).not.toHaveBeenCalled();
    expect(operationFixture.createOperationInTransaction).not.toHaveBeenCalled();
  });

  it("locks capacity before reading state and enqueues start after admission", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000102";
    const tenantId = "00000000-0000-0000-0000-000000000202";
    const order: string[] = [];
    const tx = {
      appGroup: {
        findFirst: vi.fn().mockImplementation(() => {
          order.push("read");
          return Promise.resolve({
            id: appGroupId,
            tenantId,
            name: "api",
            status: "Ready",
            runtimeState: RuntimeState.Stopped,
            currentDeploymentVersion: null,
            singleApps: [],
          });
        }),
        update: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          runtimeState: RuntimeState.Running,
          currentDeploymentVersion: null,
          singleApps: [],
        }),
      },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Tenant" }) },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          tenant: {
            status: "Active",
            billing: { balance: new Prisma.Decimal(10) },
          },
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const lockRuntimeMutation = vi.fn().mockImplementation(() => {
      order.push("lock");
      return Promise.resolve();
    });
    const admitRuntimeStart = vi.fn().mockImplementation(() => {
      order.push("admit");
      return Promise.resolve({ success: true });
    });
    const capacity = {
      lockRuntimeMutation,
      admitRuntimeStart,
    } as unknown as CapacityPreflightService;
    const operationFixture = operations();
    const service = new AppGroupRuntimeOperationsService(
      prisma,
      capacity,
      operationFixture.repository,
      maintenance,
    );

    const result = await service.startAppGroup(
      tenantId,
      appGroupId,
      actor("user-2"),
    );

    expect(order).toEqual(["lock", "read", "admit"]);
    expect(operationFixture.createOperationInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "APP_GROUP_START", resourceId: appGroupId }),
    );
    expect(result).toMatchObject({ runtimeApplied: false, operationId: "operation-1" });
  });

  it("serializes AppGroup stop and enqueues worker execution", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000103";
    const tenantId = "00000000-0000-0000-0000-000000000203";
    const order: string[] = [];
    const tx = {
      appGroup: {
        findFirst: vi.fn().mockImplementation(() => {
          order.push("read");
          return Promise.resolve({
            id: appGroupId,
            tenantId,
            name: "api",
            status: "Ready",
            runtimeState: RuntimeState.Running,
            currentDeploymentVersion: null,
            singleApps: [],
          });
        }),
        update: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: null,
          singleApps: [],
        }),
      },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Tenant" }) },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const lockRuntimeMutation = vi.fn().mockImplementation(() => {
      order.push("lock");
      return Promise.resolve();
    });
    const capacity = {
      lockRuntimeMutation,
      admitRuntimeStart: vi.fn(),
    } as unknown as CapacityPreflightService;
    const operationFixture = operations();
    const service = new AppGroupRuntimeOperationsService(
      prisma,
      capacity,
      operationFixture.repository,
      maintenance,
    );

    await service.stopAppGroup(tenantId, appGroupId, actor("user-3"));

    expect(order).toEqual(["lock", "read"]);
    expect(operationFixture.createOperationInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "APP_GROUP_STOP", resourceId: appGroupId }),
    );
  });
});
