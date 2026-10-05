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
  it("removes runtime state before deleting the App Group row", async () => {
    const prisma = {
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
