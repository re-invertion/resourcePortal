import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { WorkerRuntimeObservabilityService } from "./worker-runtime-observability.service";


type WorkerUpsertArgs = {
  where: { workerId: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

type WorkerUpdateArgs = {
  where: { workerId: string };
  data: Record<string, unknown>;
};

type ReconcileUpsertArgs = {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

function config(values: Record<string, string> = {}) {
  return {
    get: <T = string>(key: string, fallback?: T) =>
      (values[key] ?? fallback) as T,
  } as ConfigService;
}

describe("WorkerRuntimeObservabilityService", () => {
  it("persists startup, operation and reconciliation state", async () => {
    const workerUpsert = vi
      .fn<(args: WorkerUpsertArgs) => Promise<{ workerId: string }>>()
      .mockResolvedValue({ workerId: "worker-1" });
    const workerUpdateMany = vi
      .fn<(args: WorkerUpdateArgs) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 1 });
    const reconcileUpsert = vi
      .fn<(args: ReconcileUpsertArgs) => Promise<{ key: string }>>()
      .mockResolvedValue({ key: "drift" });
    const prisma = {
      workerRuntimeState: {
        upsert: workerUpsert,
        updateMany: workerUpdateMany,
      },
      workerReconciliationState: { upsert: reconcileUpsert },
    } as unknown as PrismaService;
    const service = new WorkerRuntimeObservabilityService(prisma, config());
    const startedAt = new Date("2026-09-19T20:00:00Z");
    const completedAt = new Date("2026-09-19T20:00:02Z");

    await service.started("worker-1", startedAt);
    await service.operation(
      "worker-1",
      "11111111-1111-4111-8111-111111111111",
      "Succeeded",
      completedAt,
    );
    await service.reconciliation({
      workerId: "worker-1",
      key: "drift",
      startedAt,
      completedAt,
      success: true,
      result: { scanned: 4, drifted: 1, bytes: 5n },
    });

    const startup = workerUpsert.mock.calls[0]?.[0];
    expect(startup?.where).toEqual({ workerId: "worker-1" });
    expect(startup?.create).toMatchObject({ status: "Running" });

    const operationUpdate = workerUpdateMany.mock.calls.find(
      ([args]) => args.data.lastOperationStatus === "Succeeded",
    )?.[0];
    expect(operationUpdate?.data.lastOperationStatus).toBe("Succeeded");

    const reconciliation = reconcileUpsert.mock.calls[0]?.[0];
    expect(reconciliation?.create).toMatchObject({
      lastDurationMs: 2000,
      successCount: 1,
      failureCount: 0,
      lastResult: { scanned: 4, drifted: 1, bytes: "5" },
    });
  });

  it("marks stale running workers as degraded", async () => {
    const prisma = {
      workerRuntimeState: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: "Running",
            heartbeatAt: new Date("2026-09-19T20:00:00Z"),
          },
        ]),
      },
      workerReconciliationState: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new WorkerRuntimeObservabilityService(
      prisma,
      config({ WORKER_HEALTH_STALE_SECONDS: "30" }),
    );

    await expect(
      service.workerHealth(new Date("2026-09-19T20:01:00Z")),
    ).resolves.toEqual({
      status: "degraded",
      service: "resource-portal-worker",
      workers: { total: 1, active: 0, stale: 1 },
      reconciliations: { failing: 0 },
    });
  });

  it("reports a reconciliation as failing until a later success exists", async () => {
    const prisma = {
      workerRuntimeState: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: "Running",
            heartbeatAt: new Date("2026-09-19T20:00:50Z"),
          },
        ]),
      },
      workerReconciliationState: {
        findMany: vi.fn().mockResolvedValue([
          {
            lastSuccessAt: new Date("2026-09-19T19:59:00Z"),
            lastFailureAt: new Date("2026-09-19T20:00:30Z"),
          },
        ]),
      },
    } as unknown as PrismaService;
    const service = new WorkerRuntimeObservabilityService(prisma, config());

    await expect(
      service.workerHealth(new Date("2026-09-19T20:01:00Z")),
    ).resolves.toMatchObject({
      status: "ok",
      workers: { active: 1 },
      reconciliations: { failing: 1 },
    });
  });
});
