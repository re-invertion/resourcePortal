import { describe, expect, it, vi } from "vitest";
import { AppGroupsService } from "./app-groups.service";
import { assertGpuDraftHasNoDeploymentHistory, assertGpuExistingAppsNeverAttemptedGpuRuntime } from "./nvidia-gpu-draft-discard";

const GPU_APP = "11111111-1111-4111-8111-111111111111";
const OTHER_APP = "22222222-2222-4222-8222-222222222222";
const attempt = (appIds: string[]) => ({
  stackConfig: JSON.stringify({ singleApps: appIds.map((id) => ({ id })) }),
});

describe("GPU draft discard only releases never-deployed devices", () => {
  it("permits deleting a GPU allocation created purely as an undeployed draft", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
      attempt([OTHER_APP]),
    ])).not.toThrow();
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [])).not.toThrow();
  });

  it("blocks release when even a failed candidate may have started the GPU app", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
      attempt([OTHER_APP]), attempt([GPU_APP]),
    ])).toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
  });

  it("fails closed for malformed or unavailable rollout history", () => {
    for (const stackConfig of [null, "", "{bad", "{}", '{"singleApps":[null]}']) {
      expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
        { stackConfig },
      ])).toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
  });

  it("does not interrupt conventional CPU-only draft discards", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([], [
      { stackConfig: null },
    ])).not.toThrow();
  });
});

describe("existing CPU-only app draft GPU discard", () => {
  const cpu = { stackConfig: JSON.stringify({ singleApps: [
    { id: GPU_APP, resources: { gpu: 0, gpuUuid: null } },
  ] }) };
  const gpu = { stackConfig: JSON.stringify({ singleApps: [
    { id: GPU_APP, resources: { gpu: 1, gpuUuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
  ] }) };
  it("permits releasing only a new draft GPU reservation on historic CPU-only workloads", () => {
    expect(() => assertGpuExistingAppsNeverAttemptedGpuRuntime([GPU_APP], [cpu])).not.toThrow();
  });
  it("blocks release if any failed or completed candidate ever carried that GPU", () => {
    expect(() => assertGpuExistingAppsNeverAttemptedGpuRuntime([GPU_APP], [cpu, gpu]))
      .toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
  });
  it("rejects unknown, malformed, missing or legacy GPU usage evidence", () => {
    for (const history of [
      [],
      [{ stackConfig: null }],
      [{ stackConfig: "{}" }],
      [{ stackConfig: JSON.stringify({singleApps:[{id:GPU_APP}]}) }],
      [{ stackConfig: JSON.stringify({singleApps:[]}) }],
    ]) {
      expect(() => assertGpuExistingAppsNeverAttemptedGpuRuntime([GPU_APP], history))
        .toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
  });
});


describe("discard previously deployed CPU-only app with a newly reserved GPU", () => {
  const groupId = "33333333-3333-4333-8333-333333333333";
  const tenantId = "44444444-4444-4444-8444-444444444444";
  const snapshot = {
    singleApps: [{
      id: GPU_APP, name: "cpu-service", image: "nginx:1",
      resources: { cpu: "0.5", memoryBytes: "536870912", gpu: 0, gpuUuid: null },
      healthCheck: null, secrets: [],
    }],
  };

  function fixture(history: Array<{ stackConfig: string | null }>) {
    const reachedSnapshotRestore = new Error("ReachedSnapshotRestore");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      singleApp: {
        findMany: vi.fn().mockResolvedValue([]), // Existing app, not a new draft.
        update: vi.fn().mockRejectedValue(reachedSnapshotRestore),
        deleteMany: vi.fn(),
      },
      gpuDevice: {
        findMany: vi.fn().mockResolvedValue([{ allocatedSingleAppId: GPU_APP }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      appGroupDeployment: { findMany: vi.fn().mockResolvedValue(history) },
    };
    const prisma = {
      appGroup: { findFirst: vi.fn().mockResolvedValue({
        id: groupId, tenantId, hasPendingChanges: true,
      }) },
      $transaction: vi.fn((fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = Object.create(AppGroupsService.prototype) as AppGroupsService;
    Reflect.set(service, "prisma", prisma);
    Reflect.set(service, "assertNoActiveDeployment", vi.fn().mockResolvedValue(undefined));
    Reflect.set(service, "findCurrentDeploymentSnapshot", vi.fn().mockResolvedValue(snapshot));
    return { service, tx, reachedSnapshotRestore };
  }

  it("releases only the undeployed GPU claim before restoring the CPU snapshot", async () => {
    const { service, tx, reachedSnapshotRestore } = fixture([{
      stackConfig: JSON.stringify(snapshot),
    }]);
    await expect(service.discardDraftChanges(tenantId, groupId,
      { id: tenantId } as never)).rejects.toBe(reachedSnapshotRestore);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.gpuDevice.updateMany).toHaveBeenCalledWith({
      where: { allocatedSingleAppId: { in: [GPU_APP] } },
      data: { allocatedSingleAppId: null, allocationState: "Free", allocatedAt: null },
    });
    expect(tx.singleApp.deleteMany).not.toHaveBeenCalled();
  });

  it("retains the exclusive claim and avoids snapshot writes when failed GPU deployment history exists", async () => {
    const { service, tx } = fixture([
      { stackConfig: JSON.stringify(snapshot) },
      { stackConfig: JSON.stringify({ singleApps: [{
        id: GPU_APP, resources: { gpu: 1, gpuUuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      }] }) },
    ]);
    await expect(service.discardDraftChanges(tenantId, groupId,
      { id: tenantId } as never)).rejects.toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    expect(tx.gpuDevice.updateMany).not.toHaveBeenCalled();
    expect(tx.singleApp.update).not.toHaveBeenCalled();
  });
});