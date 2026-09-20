import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type WorkerReconcileKey =
  | "certificate"
  | "ingress"
  | "drift"
  | "volumeUsage"
  | "legacySecrets"
  | "egressPolicy";

@Injectable()
export class WorkerRuntimeObservabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async started(workerId: string, now = new Date()) {
    return this.prisma.workerRuntimeState.upsert({
      where: { workerId },
      create: {
        workerId,
        status: "Running",
        startedAt: now,
        heartbeatAt: now,
        lastLoopAt: now,
      },
      update: {
        status: "Running",
        startedAt: now,
        heartbeatAt: now,
        lastLoopAt: now,
        stoppedAt: null,
        lastError: null,
      },
    });
  }

  async heartbeat(workerId: string, now = new Date()) {
    return this.prisma.workerRuntimeState.updateMany({
      where: { workerId },
      data: { heartbeatAt: now },
    });
  }

  async loop(workerId: string, now = new Date()) {
    return this.prisma.workerRuntimeState.updateMany({
      where: { workerId },
      data: { heartbeatAt: now, lastLoopAt: now },
    });
  }

  async operation(
    workerId: string,
    operationId: string,
    status: string,
    now = new Date(),
  ) {
    return this.prisma.workerRuntimeState.updateMany({
      where: { workerId },
      data: {
        heartbeatAt: now,
        lastOperationId: operationId,
        lastOperationStatus: status,
        lastOperationAt: now,
      },
    });
  }

  async reconciliation(input: {
    workerId: string;
    key: WorkerReconcileKey;
    startedAt: Date;
    completedAt: Date;
    success: boolean;
    result?: unknown;
    error?: string | null;
  }) {
    const durationMs = Math.max(
      0,
      input.completedAt.getTime() - input.startedAt.getTime(),
    );
    const lastResult =
      input.result === undefined ? undefined : this.jsonValue(input.result);

    await this.prisma.workerRuntimeState.updateMany({
      where: { workerId: input.workerId },
      data: { heartbeatAt: input.completedAt },
    });

    return this.prisma.workerReconciliationState.upsert({
      where: {
        workerId_key: { workerId: input.workerId, key: input.key },
      },
      create: {
        workerId: input.workerId,
        key: input.key,
        lastStartedAt: input.startedAt,
        lastCompletedAt: input.completedAt,
        lastSuccessAt: input.success ? input.completedAt : null,
        lastFailureAt: input.success ? null : input.completedAt,
        lastDurationMs: durationMs,
        lastResult: lastResult ?? Prisma.JsonNull,
        lastError: input.success ? null : input.error ?? "Unknown error",
        successCount: input.success ? 1 : 0,
        failureCount: input.success ? 0 : 1,
      },
      update: {
        lastStartedAt: input.startedAt,
        lastCompletedAt: input.completedAt,
        ...(input.success
          ? {
              lastSuccessAt: input.completedAt,
              lastError: null,
              successCount: { increment: 1 },
            }
          : {
              lastFailureAt: input.completedAt,
              lastError: input.error ?? "Unknown error",
              failureCount: { increment: 1 },
            }),
        lastDurationMs: durationMs,
        ...(lastResult === undefined ? {} : { lastResult }),
      },
    });
  }

  async stopped(workerId: string, now = new Date()) {
    return this.prisma.workerRuntimeState.updateMany({
      where: { workerId },
      data: {
        status: "Stopped",
        heartbeatAt: now,
        stoppedAt: now,
      },
    });
  }

  async crashed(workerId: string, error: string, now = new Date()) {
    return this.prisma.workerRuntimeState.updateMany({
      where: { workerId },
      data: {
        status: "Crashed",
        heartbeatAt: now,
        stoppedAt: now,
        lastError: error,
      },
    });
  }

  staleAfterMs() {
    const configured = Number.parseInt(
      this.config.get<string>("WORKER_HEALTH_STALE_SECONDS", "30"),
      10,
    );
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : 30;
    return seconds * 1000;
  }

  async workerHealth(now = new Date()) {
    const staleBefore = new Date(now.getTime() - this.staleAfterMs());
    const workers = await this.prisma.workerRuntimeState.findMany({
      select: { status: true, heartbeatAt: true },
    });
    const reconciliations = await this.prisma.workerReconciliationState.findMany({
      select: { lastSuccessAt: true, lastFailureAt: true },
    });

    const active = workers.filter(
      (worker) =>
        worker.status === "Running" && worker.heartbeatAt.getTime() >= staleBefore.getTime(),
    ).length;
    const stale = workers.filter(
      (worker) =>
        worker.status === "Running" && worker.heartbeatAt.getTime() < staleBefore.getTime(),
    ).length;
    const failingReconciliations = reconciliations.filter(
      (item) =>
        item.lastFailureAt !== null &&
        (item.lastSuccessAt === null || item.lastFailureAt > item.lastSuccessAt),
    ).length;

    return {
      status: active > 0 ? "ok" : "degraded",
      service: "resource-portal-worker",
      workers: { total: workers.length, active, stale },
      reconciliations: { failing: failingReconciliations },
    };
  }

  async diagnostics(now = new Date()) {
    const staleBefore = new Date(now.getTime() - this.staleAfterMs());
    const [workers, reconciliations, operationGroups, retryCount, driftGroups, oldestPending] =
      await Promise.all([
        this.prisma.workerRuntimeState.findMany({
          orderBy: { workerId: "asc" },
        }),
        this.prisma.workerReconciliationState.findMany({
          orderBy: [{ workerId: "asc" }, { key: "asc" }],
        }),
        this.prisma.operation.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        this.prisma.operationEvent.count({ where: { event: "RetryScheduled" } }),
        this.prisma.appGroup.groupBy({
          by: ["driftStatus"],
          _count: { _all: true },
        }),
        this.prisma.operation.findFirst({
          where: { status: "Pending" },
          orderBy: { createdAt: "asc" },
          select: { id: true, type: true, createdAt: true },
        }),
      ]);

    return {
      generatedAt: now,
      staleAfterSeconds: this.staleAfterMs() / 1000,
      workers: workers.map((worker) => ({
        ...worker,
        healthy:
          worker.status === "Running" && worker.heartbeatAt.getTime() >= staleBefore.getTime(),
      })),
      reconciliations,
      operations: {
        byStatus: Object.fromEntries(
          operationGroups.map((group) => [group.status, group._count._all]),
        ),
        retryEvents: retryCount,
        oldestPending,
      },
      drift: Object.fromEntries(
        driftGroups.map((group) => [group.driftStatus, group._count._all]),
      ),
    };
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue {
    const normalized = normalizeJson(value);
    if (!isInputJsonValue(normalized)) {
      throw new Error("Worker reconciliation result is not JSON serializable");
    }
    return normalized;
  }
}

function normalizeJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

function isInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isInputJsonValue);
  if (value && typeof value === "object") {
    return Object.values(value).every(
      (item) => item === null || isInputJsonValue(item),
    );
  }
  return false;
}
