import { describe, expect, it } from "vitest";
import { NvidiaGpuAllocationService } from "./nvidia-gpu-allocation.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GPU2 = "GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const appA = "00000000-0000-4000-8000-000000000011";
const appB = "00000000-0000-4000-8000-000000000012";

function fakeDatabase() {
  const apps = new Map([
    [appA, { id: appA, appGroupId: "group-a", pendingDeletion: false, gpu: 0, desiredReplicas: 1, appGroup: { tenantId: tenantA, status: "Active" } }],
    [appB, { id: appB, appGroupId: "group-b", pendingDeletion: false, gpu: 0, desiredReplicas: 1, appGroup: { tenantId: tenantB, status: "Active" } }],
  ]);
  const devices = new Map([
    [GPU, { uuid: GPU, allocatedSingleAppId: null as string | null, observedState: "Available", allocationState: "Free", allocatedAt: null as Date | null, lastObservedAt: new Date(),
      remoteLocation: { status: "Ready", availability: "Active" } }],
    [GPU2, { uuid: GPU2, allocatedSingleAppId: null as string | null, observedState: "Available", allocationState: "Free", allocatedAt: null as Date | null, lastObservedAt: new Date(),
      remoteLocation: { status: "Ready", availability: "Active" } }],
  ]);
  const quotas = new Map([[tenantA, { gpu: 1 }], [tenantB, { gpu: 1 }]]);
  const auditWrites: Array<Record<string, unknown>> = [];
  const tx = {
    tenant: { findUniqueOrThrow: ({ where }: { where: { id: string } }) => ({ name: where.id }) },
    auditLogEntry: { create: ({ data }: { data: Record<string, unknown> }) => {
      auditWrites.push(data); return Promise.resolve(data);
    } },
    $queryRaw: () => Promise.resolve([]),
    singleApp: {
      findUnique: ({ where }: { where: { id: string } }) => apps.get(where.id) ?? null,
      update: ({ where, data }: { where: { id: string }; data: { gpu: number } }) =>
        Object.assign(apps.get(where.id)!, data),
    },
    appGroup: { update: () => Promise.resolve({}) },
    quota: {
      findUnique: ({ where }: { where: { tenantId: string } }) => quotas.get(where.tenantId) ?? null,
    },
    gpuDevice: {
      findUnique: ({ where }: { where: { uuid?: string; allocatedSingleAppId?: string } }) =>
        where.uuid ? devices.get(where.uuid) ?? null : [...devices.values()].find((d) => d.allocatedSingleAppId === where.allocatedSingleAppId) ?? null,
      findFirst: ({ where }: { where: { allocatedSingleAppId: string } }) =>
        [...devices.values()].find((d) => d.allocatedSingleAppId === where.allocatedSingleAppId) ?? null,
      count: ({ where }: { where: { allocatedSingleApp: { appGroup: { tenantId: string } } } }) =>
        [...devices.values()].filter((d) => d.allocatedSingleAppId && apps.get(d.allocatedSingleAppId)?.appGroup.tenantId === where.allocatedSingleApp.appGroup.tenantId).length,
      updateMany: ({ where, data }: {
        where: { uuid: string; allocatedSingleAppId: null; allocationState: string; observedState: string };
        data: { allocatedSingleAppId: string; allocationState: string; allocatedAt: Date };
      }) => {
        const d = devices.get(where.uuid);
        if (!d || d.allocatedSingleAppId !== null || d.allocationState !== where.allocationState || d.observedState !== where.observedState) return { count: 0 };
        Object.assign(d, data);
        return { count: 1 };
      },
      update: ({ where, data }: { where: { uuid: string }; data: { allocatedSingleAppId: null; allocationState: string; allocatedAt: null } }) =>
        Object.assign(devices.get(where.uuid)!, data),
      upsert: ({ where, create, update }: { where: { uuid: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const d = devices.get(where.uuid);
        if (d) return Object.assign(d, update);
        const fresh = create as never;
        devices.set(where.uuid, fresh);
        return fresh;
      },
    },
  };
  let tail = Promise.resolve();
  const prisma = {
    // An in-memory serialization of the PostgreSQL advisory transaction, in
    // addition to the production DB's unique indexes and compare-and-swap.
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
      const prior = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => { unlock = resolve; });
      await prior;
      try { return await fn(tx); } finally { unlock(); }
    },
    gpuDevice: tx.gpuDevice,
  };
  return { service: new NvidiaGpuAllocationService(prisma as never), devices, apps, quotas, auditWrites };
}

describe("dedicated NVIDIA GPU allocation transactions", () => {
  it("allows exactly one owner when two tenants concurrently claim one card", async () => {
    const { service, devices } = fakeDatabase();
    const results = await Promise.allSettled([
      service.reserve(tenantA, "group-a", appA, GPU),
      service.reserve(tenantB, "group-b", appB, GPU),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(devices.get(GPU)?.allocatedSingleAppId).toBe(appA);
  });

  it("is idempotent for an existing owner, and never reassigns silently", async () => {
    const { service } = fakeDatabase();
    expect((await service.reserve(tenantA, "group-a", appA, GPU)).alreadyAllocated).toBe(false);
    expect((await service.reserve(tenantA, "group-a", appA, GPU)).alreadyAllocated).toBe(true);
    await expect(service.reserve(tenantA, "group-a", appA, GPU2)).rejects.toThrow("GpuReassignmentRequiresDetach");
  });

  it("atomically audits a successful assignment with the authenticated actor", async () => {
    const { service, auditWrites, devices } = fakeDatabase();
    await service.reserve(tenantA, 'group-a', appA, GPU, {
      id: 'actor-id', displayName: 'Tenant Operator', email: 'tenant@example.org',
      status: 'Active',
    } as never);
    expect(devices.get(GPU)?.allocatedSingleAppId).toBe(appA);
    expect(auditWrites).toEqual([expect.objectContaining({
      action: 'singleapp.gpu.reserve', resourceId: appA, tenantId: tenantA,
      actor: 'actor-id', changes: { gpuUuid: GPU, allocation: 'Exclusive' },
    })]);
  });

  it("rejects reservation when an App Group is being removed", async () => {
    const { service, apps } = fakeDatabase();
    apps.get(appA)!.appGroup.status = "Deleting";
    await expect(service.reserve(tenantA, "group-a", appA, GPU)).rejects.toThrow("SingleAppNotFound");
  });

  it("blocks missing or zero quota, even for ready hardware", async () => {
    const { service, quotas } = fakeDatabase();
    quotas.delete(tenantA);
    await expect(service.reserve(tenantA, "group-a", appA, GPU)).rejects.toThrow("GpuAccessNotEnabled");
    quotas.set(tenantA, { gpu: 0 });
    await expect(service.reserve(tenantA, "group-a", appA, GPU)).rejects.toThrow("GpuAccessNotEnabled");
  });

  it("enforces one replica and the tenant's GPU count", async () => {
    const { service, apps, devices } = fakeDatabase();
    apps.get(appA)!.desiredReplicas = 2;
    await expect(service.reserve(tenantA, "group-a", appA, GPU)).rejects.toThrow("DedicatedGpuRequiresOneReplica");
    apps.get(appA)!.desiredReplicas = 1;
    await service.reserve(tenantA, "group-a", appA, GPU);
    apps.get(appB)!.appGroup.tenantId = tenantA;
    await expect(service.reserve(tenantA, "group-b", appB, GPU2)).rejects.toThrow("GpuQuotaExceeded");
    expect(devices.get(GPU2)?.allocatedSingleAppId).toBeNull();
  });

  it("retains ownership when the card goes unavailable", async () => {
    const { service, devices } = fakeDatabase();
    await service.reserve(tenantA, "group-a", appA, GPU);
    devices.get(GPU)!.observedState = "Unavailable";
    await expect(service.reserve(tenantB, "group-b", appB, GPU)).rejects.toThrow("GpuAlreadyAllocated");
    expect(devices.get(GPU)!.allocatedSingleAppId).toBe(appA);
  });

  it("never frees a stopped or failed workload without verified cleanup", async () => {
    const { service, devices } = fakeDatabase();
    await service.reserve(tenantA, "group-a", appA, GPU);
    await expect(service.releaseAfterVerifiedCleanup(appA, false)).rejects.toThrow("GpuRuntimeCleanupRequired");
    expect(devices.get(GPU)!.allocatedSingleAppId).toBe(appA);
    expect(await service.releaseAfterVerifiedCleanup(appA, true)).toMatchObject({ released: true, uuid: GPU });
    expect(devices.get(GPU)!.allocatedSingleAppId).toBeNull();
  });
});
