import { describe, expect, it, vi } from "vitest";
import { AppGroupsService } from "./app-groups.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";

describe("dedicated NVIDIA GPU SingleApp service identity", () => {
  it("permits saving unchanged identity while editing the GPU workload image", async () => {
    const rollback = new Error("TransactionReached");
    const service = Object.create(AppGroupsService.prototype) as AppGroupsService;
    const db = { $transaction: vi.fn().mockRejectedValue(rollback) };
    const quota = vi.fn().mockResolvedValue(undefined);
    const registry = { assertRegistryCanBeUsedByImage: vi.fn().mockResolvedValue(undefined) };
    Reflect.set(service, "prisma", db);
    Reflect.set(service, "registriesService", registry);
    Reflect.set(service, "ensureSingleAppBelongsToAppGroup", vi.fn().mockResolvedValue({
      id: appId, appGroupId: groupId, name: "stable-nvidia", image: "nginx:1.2",
      gpu: 1, cpu: 0.5, memoryBytes: 536870912, desiredReplicas: 1,
      pendingDeletion: false, registryId: null,
    }));
    Reflect.set(service, "assertQuotaAllowsSingleAppChange", quota);
    Reflect.set(service, "handleKnownConflict", vi.fn());
    await expect(service.updateSingleApp(tenantId, groupId, appId, {
      name: "stable-nvidia", image: "nginx:1.3", desiredReplicas: 1,
    }, { id: tenantId } as never)).rejects.toBe(rollback);
    expect(quota).toHaveBeenCalledOnce();
    expect(registry.assertRegistryCanBeUsedByImage).toHaveBeenCalledOnce();
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("rejects renaming an allocated GPU workload without changing its draft or quota", async () => {
    const service = Object.create(AppGroupsService.prototype) as AppGroupsService;
    const db = { $transaction: vi.fn() };
    const quota = vi.fn();
    Reflect.set(service, "prisma", db);
    Reflect.set(service, "ensureSingleAppBelongsToAppGroup", vi.fn().mockResolvedValue({
      id: appId, appGroupId: groupId, name: "stable-nvidia", gpu: 1,
      pendingDeletion: false, desiredReplicas: 1,
    }));
    Reflect.set(service, "assertQuotaAllowsSingleAppChange", quota);
    const method = service.updateSingleApp.bind(service);
    await expect(method(tenantId, groupId, appId, {
      name: "renamed-nvidia",
    }, { id: tenantId } as never)).rejects.toThrow(
      "DedicatedGpuCannotBeModifiedThroughGenericPatch",
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });
});