import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { ObservabilityService } from "./observability.service";

describe("shared observability metrics", () => {
  it("renders durable worker, operation, retry and drift metrics from PostgreSQL", async () => {
    const now = Date.now();
    const prisma = {
      operation: {
        groupBy: vi.fn().mockResolvedValue([
          { status: "Pending", _count: { _all: 2 } },
          { status: "Failed", _count: { _all: 1 } },
        ]),
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date(now - 20_000) }),
      },
      operationEvent: { count: vi.fn().mockResolvedValue(7) },
      appGroup: {
        groupBy: vi.fn().mockResolvedValue([
          { driftStatus: "InSync", _count: { _all: 5 } },
          { driftStatus: "Drifted", _count: { _all: 1 } },
        ]),
      },
      workerRuntimeState: {
        findMany: vi.fn().mockResolvedValue([
          {
            workerId: "worker-1",
            status: "Running",
            heartbeatAt: new Date(now - 5_000),
          },
        ]),
      },
      workerReconciliationState: {
        findMany: vi.fn().mockResolvedValue([
          {
            workerId: "worker-1",
            key: "drift",
            lastFailureAt: null,
            lastSuccessAt: new Date(now - 5_000),
            successCount: 11,
            failureCount: 2,
            lastDurationMs: 1250,
          },
        ]),
      },
      remoteLocation: { findMany: vi.fn().mockResolvedValue([]) },
      storageBackend: { findMany: vi.fn().mockResolvedValue([]) },
      volume: { groupBy: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const config = {
      get: vi.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService;
    const service = new ObservabilityService(prisma, config);

    const metrics = await service.renderPrometheusMetrics();

    expect(metrics).toContain('resource_portal_operations{status="Pending"} 2');
    expect(metrics).toContain("resource_portal_operation_retry_events_total 7");
    expect(metrics).toContain(
      'resource_portal_app_groups_drift{status="Drifted"} 1',
    );
    expect(metrics).toContain("resource_portal_workers_active 1");
    expect(metrics).toContain(
      'resource_portal_worker_reconciliation_success_total{worker_id="worker-1",reconciliation="drift"} 11',
    );
    expect(metrics).toContain("resource_portal_observability_database_query_success 1");
  });

  it("keeps the metrics endpoint alive when shared DB metrics cannot be read", async () => {
    const prisma = {
      operation: { groupBy: vi.fn().mockRejectedValue(new Error("postgres down")) },
      operationEvent: { count: vi.fn() },
      appGroup: { groupBy: vi.fn() },
      workerRuntimeState: { findMany: vi.fn() },
      workerReconciliationState: { findMany: vi.fn() },
      remoteLocation: { findMany: vi.fn() },
      storageBackend: { findMany: vi.fn() },
      volume: { groupBy: vi.fn() },
    } as unknown as PrismaService;
    const service = new ObservabilityService(prisma);

    const metrics = await service.renderPrometheusMetrics();
    expect(metrics).toContain("resource_portal_up 1");
    expect(metrics).toContain("resource_portal_observability_database_query_success 0");
  });
});
