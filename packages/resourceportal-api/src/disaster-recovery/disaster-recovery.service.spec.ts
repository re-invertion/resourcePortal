import { describe, expect, it, vi } from "vitest";
import { RuntimeDriftReconcilerService } from "../internal/runtime-drift-reconciler.service";
import { IngressReconcilerService } from "../internal/ingress-reconciler.service";
import { SwarmInfrastructureService } from "../platform-infrastructure/swarm-infrastructure.service";
import { StorageBackendsService } from "../storage-backends/storage-backends.service";
import { DisasterRecoveryService } from "./disaster-recovery.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

describe("DisasterRecoveryService", () => {
  it("reconciles external control-plane state after restore", async () => {
    const swarmReconcile = vi.fn().mockResolvedValue({
      nodeCount: 3,
      managerCount: 1,
      discovered: 0,
      removed: 0,
      health: "Healthy",
    });
    const listBackends = vi.fn().mockResolvedValue([
      { id: "storage-1" },
      { id: "storage-2" },
    ]);
    const validateBackend = vi.fn().mockResolvedValue({ status: "Ready" });
    const runtimeRestore = vi.fn().mockResolvedValue({
      checked: 2,
      applied: 2,
      failed: 0,
      skipped: 0,
    });
    const runtimeReconcile = vi.fn().mockResolvedValue({
      scanned: 2,
      inSync: 2,
      drifted: 0,
      unknown: 0,
    });
    const ingressReconcile = vi.fn().mockResolvedValue({
      checked: 2,
      changed: 0,
      failed: 0,
    });

    const service = new DisasterRecoveryService(
      { reconcile: swarmReconcile } as unknown as SwarmInfrastructureService,
      {
        listBackends,
        validateBackend,
      } as unknown as StorageBackendsService,
      { reconcile: runtimeRestore } as unknown as RuntimeRestoreService,
      { reconcileBatch: runtimeReconcile } as unknown as RuntimeDriftReconcilerService,
      { reconcileBatch: ingressReconcile } as unknown as IngressReconcilerService,
    );

    const result = await service.reconcileAfterRestore();

    expect(result.swarm.nodeCount).toBe(3);
    expect(result.swarm.health).toBe("Healthy");
    expect(result.storage).toEqual({ checked: 2, failed: 0 });
    expect(result.runtimeRestore).toEqual({
      checked: 2,
      applied: 2,
      failed: 0,
      skipped: 0,
    });
    expect(result.runtime.scanned).toBe(2);
    expect(result.runtime.inSync).toBe(2);
    expect(result.ingress.checked).toBe(2);
    expect(result.ingress.failed).toBe(0);
    expect(result.healthy).toBe(true);

    expect(swarmReconcile).toHaveBeenCalledOnce();
    expect(listBackends).toHaveBeenCalledOnce();
    expect(validateBackend).toHaveBeenNthCalledWith(1, "storage-1");
    expect(validateBackend).toHaveBeenNthCalledWith(2, "storage-2");
    expect(runtimeRestore).toHaveBeenCalledOnce();
    expect(runtimeReconcile).toHaveBeenCalledWith(10_000);
    expect(ingressReconcile).toHaveBeenCalledOnce();
  });

  it("reports failures without skipping the remaining reconciliation stages", async () => {
    const runtimeRestore = vi.fn().mockResolvedValue({
      checked: 1,
      applied: 0,
      failed: 1,
      skipped: 0,
    });
    const runtimeReconcile = vi.fn().mockResolvedValue({
      scanned: 1,
      inSync: 0,
      drifted: 1,
      unknown: 0,
    });
    const ingressReconcile = vi.fn().mockResolvedValue({
      checked: 1,
      changed: 0,
      failed: 0,
    });

    const service = new DisasterRecoveryService(
      {
        reconcile: vi.fn().mockResolvedValue({ nodeCount: 1, health: "Healthy" }),
      } as unknown as SwarmInfrastructureService,
      {
        listBackends: vi.fn().mockResolvedValue([{ id: "storage-1" }]),
        validateBackend: vi.fn().mockRejectedValue(new Error("Ceph unavailable")),
      } as unknown as StorageBackendsService,
      { reconcile: runtimeRestore } as unknown as RuntimeRestoreService,
      { reconcileBatch: runtimeReconcile } as unknown as RuntimeDriftReconcilerService,
      { reconcileBatch: ingressReconcile } as unknown as IngressReconcilerService,
    );

    const result = await service.reconcileAfterRestore();

    expect(result.storage).toEqual({ checked: 1, failed: 1 });
    expect(result.runtimeRestore.failed).toBe(1);
    expect(result.healthy).toBe(false);
    expect(runtimeRestore).toHaveBeenCalledOnce();
    expect(runtimeReconcile).toHaveBeenCalledOnce();
    expect(ingressReconcile).toHaveBeenCalledOnce();
  });
});
