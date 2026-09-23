import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingWorkerService } from "./billing/billing-worker.service";
import { SwarmInfrastructureReconcilerService } from "./platform-infrastructure/swarm-infrastructure-reconciler.service";
import { StorageBackendReconcilerService } from "./storage-backends/storage-backend-reconciler.service";

function oneShotConfig() {
  return {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "WORKER_ONCE" ? "true" : fallback,
    ),
  } as unknown as ConfigService;
}

describe("WORKER_ONCE background schedulers", () => {
  const previousWorkerOnce = process.env.WORKER_ONCE;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (previousWorkerOnce === undefined) delete process.env.WORKER_ONCE;
    else process.env.WORKER_ONCE = previousWorkerOnce;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    vi.restoreAllMocks();
  });

  it("does not start billing reconciliation in one-shot mode", () => {
    process.env.NODE_ENV = "production";
    process.env.WORKER_ONCE = "true";
    const worker = new BillingWorkerService(
      {} as never,
      {} as never,
      {} as never,
    );
    const reconcile = vi
      .spyOn(worker, "reconcileClosedPeriods")
      .mockResolvedValue({ skipped: false, periodsProcessed: 0 });

    worker.onApplicationBootstrap();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not start storage backend reconciliation in one-shot mode", () => {
    const storageBackends = { validateDefaultBackend: vi.fn() };
    const reconciler = new StorageBackendReconcilerService(
      oneShotConfig(),
      storageBackends as never,
    );

    reconciler.onModuleInit();

    expect(storageBackends.validateDefaultBackend).not.toHaveBeenCalled();
  });

  it("guards worker-runner startup and periodic reconciliations behind non-one-shot mode", () => {
    const source = readFileSync(new URL("./worker.runner.ts", import.meta.url), "utf8");
    const guardedBlocks = source.match(/if \(!once\) \{[\s\S]*?\n {4}\}/g) ?? [];

    expect(guardedBlocks).toHaveLength(2);
    expect(guardedBlocks[0]).toContain('startupReconcile("drift"');
    expect(guardedBlocks[0]).toContain('legacySecrets.migrateAll()');
    expect(guardedBlocks[0]).toContain('startupReconcile("egressPolicy"');
    expect(guardedBlocks[1]).toContain('reconcile("drift"');
    expect(guardedBlocks[1]).toContain('legacySecrets.migrateAll()');
    expect(guardedBlocks[1]).toContain('reconcile("egressPolicy"');
    expect(source).toContain("processed = await operations.processNext(workerId, leaseSeconds)");
  });

  it("does not start Swarm infrastructure reconciliation in one-shot mode", () => {
    const swarm = { reconcile: vi.fn() };
    const reconciler = new SwarmInfrastructureReconcilerService(
      swarm as never,
      oneShotConfig(),
    );

    reconciler.onModuleInit();

    expect(swarm.reconcile).not.toHaveBeenCalled();
  });
});
