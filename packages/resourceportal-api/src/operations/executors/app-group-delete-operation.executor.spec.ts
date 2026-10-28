import { describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "../operation.types";
import { AppGroupDeleteOperationExecutor } from "./app-group-delete-operation.executor";

const operation = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "APP_GROUP_DELETE",
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceType: "AppGroup",
  resourceId: "33333333-3333-4333-8333-333333333333",
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdByEmail: "actor@example.com",
  createdByDisplayName: "Actor",
  input: {},
} as OperationRecord;

describe("AppGroupDeleteOperationExecutor", () => {
  it("fails closed and retains ownership if a GPU task might still be running", async () => {
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: operation.resourceId, status: "Deleting", name: "demo" }),
        deleteMany: vi.fn(),
      },
      gpuDevice: { count: vi.fn().mockResolvedValue(1), updateMany: vi.fn() },
      $transaction: vi.fn(),
    };
    const runtime = {
      removeAppGroupRuntime: vi.fn().mockResolvedValue({ success: true, changed: true }),
      verifyRemovedGpuAppGroupRuntime: vi.fn().mockResolvedValue(false),
    };
    const executor = new AppGroupDeleteOperationExecutor(prisma as never, runtime as never);
    await expect(executor.execute(operation)).rejects.toMatchObject({
      code: "AppGroupGpuRuntimeCleanupIncomplete", retryable: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.gpuDevice.updateMany).not.toHaveBeenCalled();
    expect(prisma.appGroup.deleteMany).not.toHaveBeenCalled();
  });

  it("atomically releases GPUs only after verified removal of every GPU-backed Swarm service", async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: operation.resourceId }),
        deleteMany: vi.fn().mockImplementation(() => { calls.push("delete"); return { count: 1 }; }),
      },
      gpuDevice: {
        updateMany: vi.fn().mockImplementation(() => { calls.push("release"); return { count: 1 }; }),
      },
    };
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: operation.resourceId, status: "Deleting", name: "demo" }),
        deleteMany: vi.fn(),
      },
      gpuDevice: { count: vi.fn().mockResolvedValue(1) },
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    };
    const runtime = {
      removeAppGroupRuntime: vi.fn().mockResolvedValue({ success: true, changed: true }),
      verifyRemovedGpuAppGroupRuntime: vi.fn().mockImplementation(() => {
        calls.push("verify");
        return true;
      }),
    };
    const executor = new AppGroupDeleteOperationExecutor(prisma as never, runtime as never);
    await expect(executor.execute(operation)).resolves.toMatchObject({
      result: { deleted: true, runtimeChanged: true },
    });
    expect(calls).toEqual(["verify", "release", "delete"]);
    expect(tx.gpuDevice.updateMany).toHaveBeenCalledWith({
      where: { allocatedSingleApp: { appGroupId: operation.resourceId } },
      data: { allocatedSingleAppId: null, allocationState: "Free", allocatedAt: null },
    });
    expect(prisma.appGroup.deleteMany).not.toHaveBeenCalled();
  });

  it("removes runtime state before deleting the App Group row", async () => {
    const prisma = {
      gpuDevice: { count: vi.fn().mockResolvedValue(0) },
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: operation.resourceId,
          name: "demo",
          status: "Deleting",
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const runtime = {
      removeAppGroupRuntime: vi.fn().mockResolvedValue({
        success: true,
        changed: true,
      }),
    };
    const executor = new AppGroupDeleteOperationExecutor(
      prisma as never,
      runtime as never,
    );

    await expect(executor.execute(operation)).resolves.toEqual({
      resourceId: operation.resourceId,
      result: {
        deleted: true,
        alreadyApplied: false,
        runtimeChanged: true,
      },
    });

    expect(runtime.removeAppGroupRuntime).toHaveBeenCalledWith(operation.resourceId);
    expect(prisma.appGroup.deleteMany).toHaveBeenCalledWith({
      where: {
        id: operation.resourceId,
        tenantId: operation.tenantId,
        status: "Deleting",
      },
    });
    expect(
      runtime.removeAppGroupRuntime.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.appGroup.deleteMany.mock.invocationCallOrder[0]);
  });

  it("is idempotent when the App Group was already deleted", async () => {
    const prisma = {
      gpuDevice: { count: vi.fn().mockResolvedValue(0) },
      appGroup: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn(),
      },
    };
    const runtime = { removeAppGroupRuntime: vi.fn() };
    const executor = new AppGroupDeleteOperationExecutor(
      prisma as never,
      runtime as never,
    );

    await expect(executor.execute(operation)).resolves.toMatchObject({
      result: { deleted: true, alreadyApplied: true },
    });
    expect(runtime.removeAppGroupRuntime).not.toHaveBeenCalled();
    expect(prisma.appGroup.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the database row and requests retry when Docker cleanup is incomplete", async () => {
    const prisma = {
      gpuDevice: { count: vi.fn().mockResolvedValue(0) },
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: operation.resourceId,
          name: "demo",
          status: "Deleting",
        }),
        deleteMany: vi.fn(),
      },
    };
    const runtime = {
      removeAppGroupRuntime: vi.fn().mockResolvedValue({
        success: false,
        changed: true,
        error: "network has active endpoints",
      }),
    };
    const executor = new AppGroupDeleteOperationExecutor(
      prisma as never,
      runtime as never,
    );

    await expect(executor.execute(operation)).rejects.toMatchObject({
      code: "AppGroupRuntimeCleanupFailed",
      retryable: true,
    });
    expect(prisma.appGroup.deleteMany).not.toHaveBeenCalled();
  });
});
