import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  correlatedExistingDemand,
  evaluateHybridNodeAdmission,
  predictAppMemory,
  type AppMemoryPrediction,
  type CapacityPolicy,
  type HybridNodeDecision,
  type MemoryObservation,
} from "./capacity-hybrid.logic";
import { CapacityPolicyService } from "./capacity-policy.service";
import { CapacityTelemetryStore } from "./capacity-telemetry.store";
import { SwarmCapacityNodeProbeRouter } from "./swarm-capacity-node-probe-router";
import type { CapacityDeploymentSnapshot } from "./capacity-preflight.service";

type RunningAppCapacity = {
  appId: string;
  hardLimitBytes: bigint;
};

export type HybridAdmissionEvaluation =
  | {
      usable: true;
      decision: HybridNodeDecision;
      predictions: AppMemoryPrediction[];
      requestedPredictedBytes: bigint;
      reason: string;
    }
  | {
      usable: false;
      reason: string;
    };

@Injectable()
export class CapacityTelemetryService {
  private readonly logger = new Logger(CapacityTelemetryService.name);

  constructor(
    private readonly store: CapacityTelemetryStore,
    private readonly policyService: CapacityPolicyService,
    private readonly prisma: PrismaService,
    private readonly nodeProbe: SwarmCapacityNodeProbeRouter,
  ) {}

  async restorePolicy() {
    const stored = await this.prisma.workerReconciliationState.findFirst({
      where: { key: "capacityPolicy" },
      orderBy: { updatedAt: "desc" },
      select: { lastResult: true },
    });
    if (
      !stored?.lastResult ||
      typeof stored.lastResult !== "object" ||
      Array.isArray(stored.lastResult)
    ) {
      return;
    }
    try {
      this.policyService.set(stored.lastResult);
    } catch (error) {
      this.logger.warn(
        "Ignoring invalid persisted capacity policy: " +
          (error instanceof Error ? error.message : "unknown error"),
      );
    }
  }

  async updatePolicy(input: Record<string, unknown>) {
    const policy = this.policyService.set(input);
    const worker = await this.prisma.workerRuntimeState.findFirst({
      orderBy: { heartbeatAt: "desc" },
      select: { workerId: true },
    });
    if (!worker) {
      throw new Error(
        "Capacity policy cannot be persisted until a ResourcePortal worker has registered",
      );
    }
    const now = new Date();
    const lastResult = this.jsonValue(this.policyService.serialize(policy));
    await this.prisma.workerReconciliationState.upsert({
      where: {
        workerId_key: {
          workerId: worker.workerId,
          key: "capacityPolicy",
        },
      },
      create: {
        workerId: worker.workerId,
        key: "capacityPolicy",
        lastStartedAt: now,
        lastCompletedAt: now,
        lastSuccessAt: now,
        lastDurationMs: 0,
        lastResult,
        successCount: 1,
        failureCount: 0,
      },
      update: {
        lastStartedAt: now,
        lastCompletedAt: now,
        lastSuccessAt: now,
        lastDurationMs: 0,
        lastResult,
        lastError: null,
        successCount: { increment: 1 },
      },
    });
    return this.policyService.serialize(policy);
  }

  policy() {
    return this.policyService.current();
  }

  async observeNow(): Promise<MemoryObservation[]> {
    const observedAt = new Date().toISOString();
    const reports = await this.nodeProbe.collect();
    if (reports.length === 0) {
      throw new Error("authenticated Swarm capacity telemetry is unavailable");
    }

    const totalBytes = reports.reduce(
      (sum, report) => sum + BigInt(report.memoryTotalBytes),
      0n,
    );
    const availableBytes = reports.reduce(
      (sum, report) => sum + BigInt(report.memoryAvailableBytes),
      0n,
    );
    const containers = reports.flatMap((report) =>
      report.containers.map((container) => ({ report, container })),
    );
    const byApp = new Map<string, typeof containers>();
    for (const entry of containers) {
      const group = byApp.get(entry.container.appId) ?? [];
      group.push(entry);
      byApp.set(entry.container.appId, group);
    }

    const points: MemoryObservation[] = [];
    for (const [appId, group] of byApp) {
      const current = group.reduce(
        (sum, item) => sum + BigInt(item.container.memoryCurrentBytes),
        0n,
      );
      const peak = group.reduce(
        (sum, item) => sum + BigInt(item.container.memoryPeakBytes),
        0n,
      );
      const oom = group.reduce(
        (sum, item) => sum + BigInt(item.container.oomEvents),
        0n,
      );
      const started = group
        .map((item) => item.container.startedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      points.push({
        observedAt,
        nodeId:
          reports.length === 1
            ? reports[0].swarmNodeId
            : "cluster",
        appId,
        containerId: group
          .map((item) => item.container.id)
          .sort()
          .join(","),
        containerStartedAt: started,
        memoryCurrentBytes: current,
        memoryPeakBytes: peak > current ? peak : current,
        oomEvents: oom,
        memoryPsiSomeAvg10: Math.max(
          ...group.map((item) =>
            Math.max(
              item.report.memoryPsiSomeAvg10,
              item.container.memoryPsiSomeAvg10 ?? 0,
            ),
          ),
        ),
        memoryPsiFullAvg10: Math.max(
          ...group.map((item) =>
            Math.max(
              item.report.memoryPsiFullAvg10,
              item.container.memoryPsiFullAvg10 ?? 0,
            ),
          ),
        ),
        nodeMemoryAvailableBytes: availableBytes,
        nodeMemoryTotalBytes: totalBytes,
        bucketSeconds: 30,
      });
    }

    for (const report of reports) {
      const current = report.containers.reduce(
        (sum, item) => sum + BigInt(item.memoryCurrentBytes),
        0n,
      );
      points.push({
        observedAt,
        nodeId: report.swarmNodeId,
        memoryCurrentBytes: current,
        memoryPeakBytes: current,
        oomEvents: report.containers.reduce(
          (sum, item) => sum + BigInt(item.oomEvents),
          0n,
        ),
        memoryPsiSomeAvg10: report.memoryPsiSomeAvg10,
        memoryPsiFullAvg10: report.memoryPsiFullAvg10,
        nodeMemoryAvailableBytes: BigInt(report.memoryAvailableBytes),
        nodeMemoryTotalBytes: BigInt(report.memoryTotalBytes),
        bucketSeconds: 30,
      });
    }

    await this.store.append(points, this.policy());
    return points;
  }

  async evaluateAdmission(input: {
    snapshot: CapacityDeploymentSnapshot;
    runningApps: RunningAppCapacity[];
    inFlightSnapshots: CapacityDeploymentSnapshot[];
    schedulableNodeCount: bigint;
  }): Promise<HybridAdmissionEvaluation> {
    await this.restorePolicy();
    const policy = this.policy();
    if (policy.mode !== "Hybrid") {
      return { usable: false, reason: "capacity mode is Strict" };
    }

    try {
      await this.observeNow();
    } catch (error) {
      this.logger.warn(
        "Hybrid telemetry refresh failed: " +
          (error instanceof Error ? error.message : "unknown error"),
      );
    }

    const latestNodes = (await this.store.latestNodes()).filter((point) => {
      const ageMs = Date.now() - Date.parse(point.observedAt);
      return (
        Number.isFinite(ageMs) &&
        ageMs <= policy.maxTelemetryAgeSeconds * 1000
      );
    });
    const expectedNodes = Number(input.schedulableNodeCount);
    if (
      !Number.isSafeInteger(expectedNodes) ||
      expectedNodes < 1 ||
      latestNodes.length !== expectedNodes
    ) {
      return {
        usable: false,
        reason:
          "authenticated fresh per-node telemetry does not cover every schedulable Swarm node",
      };
    }
    for (const latest of latestNodes) {
      if (
        latest.nodeMemoryAvailableBytes === undefined ||
        latest.nodeMemoryTotalBytes === undefined
      ) {
        return {
          usable: false,
          reason: "node memory telemetry is incomplete",
        };
      }
    }

    const currentHardByApp = new Map(
      input.runningApps.map((item) => [item.appId, item.hardLimitBytes]),
    );
    const neededAppIds = new Set<string>(input.runningApps.map((item) => item.appId));
    for (const app of input.snapshot.singleApps) {
      if (app.id) neededAppIds.add(app.id);
    }
    for (const snapshot of input.inFlightSnapshots) {
      for (const app of snapshot.singleApps) {
        if (app.id) neededAppIds.add(app.id);
      }
    }
    const historySince =
      Date.now() - policy.rareEventRetentionDays * 86_400_000;
    const histories = new Map<string, MemoryObservation[]>(
      await Promise.all(
        Array.from(neededAppIds).map(async (appId) => [
          appId,
          await this.store.appHistory(appId, historySince),
        ] as const),
      ),
    );

    const predictions: AppMemoryPrediction[] = [];
    let sumAppPredictedBytes = 0n;
    let recentOomEvents = 0n;
    for (const running of input.runningApps) {
      const prediction = predictAppMemory(
        running.appId,
        histories.get(running.appId) ?? [],
        running.hardLimitBytes,
        policy,
      );
      predictions.push(prediction);
      sumAppPredictedBytes += prediction.predictedBytes;
      recentOomEvents += prediction.recentOomEvents;
    }
    const minAppConfidence =
      predictions.length === 0
        ? 0
        : Math.min(...predictions.map((item) => item.confidence));

    const requestedPredictedBytes = this.incrementalPrediction(
      input.snapshot,
      histories,
      currentHardByApp,
      policy,
    );
    const inFlightPredictedBytes = input.inFlightSnapshots.reduce(
      (sum, snapshot) =>
        sum +
        this.incrementalPrediction(
          snapshot,
          histories,
          currentHardByApp,
          policy,
        ),
      0n,
    );

    const decisions: Array<HybridNodeDecision & { nodeId: string }> = [];
    const nodeWindowSince =
      Date.now() - policy.predictionWindowDays * 86_400_000;
    for (const latest of latestNodes) {
      const nodeWindow = await this.store.nodeHistory(
        latest.nodeId,
        nodeWindowSince,
      );
      const sortedNodeValues = nodeWindow
        .map((item) => item.memoryCurrentBytes)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const nodeP99 =
        sortedNodeValues.length === 0
          ? latest.memoryCurrentBytes
          : sortedNodeValues[
              Math.min(
                sortedNodeValues.length - 1,
                Math.ceil(sortedNodeValues.length * 0.99) - 1,
              )
            ];
      const predictedExistingBytes = correlatedExistingDemand({
        sumAppPredictedBytes,
        nodeP99Bytes: nodeP99,
        currentAppMemoryBytes: latest.memoryCurrentBytes,
        minAppConfidence,
        nodeSampleCount: nodeWindow.length,
        policy,
      });
      const decision = evaluateHybridNodeAdmission({
        nodeMemoryTotalBytes: latest.nodeMemoryTotalBytes!,
        nodeMemoryAvailableBytes: latest.nodeMemoryAvailableBytes!,
        currentAppMemoryBytes: latest.memoryCurrentBytes,
        predictedExistingBytes,
        requestedPredictedBytes,
        inFlightPredictedBytes,
        memoryPsiSomeAvg10: latest.memoryPsiSomeAvg10,
        memoryPsiFullAvg10: latest.memoryPsiFullAvg10,
        recentOomEvents,
        policy,
      });
      decisions.push({ ...decision, nodeId: latest.nodeId });
    }

    const denied = decisions.find((item) => !item.allowed);
    const mostConstrained = [...decisions].sort((a, b) => {
      const aHeadroom = a.remainingAfterAdmissionBytes - a.safetyReserveBytes;
      const bHeadroom = b.remainingAfterAdmissionBytes - b.safetyReserveBytes;
      return aHeadroom < bHeadroom ? -1 : aHeadroom > bHeadroom ? 1 : 0;
    })[0];
    const selected = denied ?? mostConstrained;
    if (!selected) {
      return { usable: false, reason: "node capacity decision is unavailable" };
    }

    const decision: HybridNodeDecision = {
      ...selected,
      reason:
        "node " +
        selected.nodeId +
        ": " +
        selected.reason,
    };
    return {
      usable: true,
      decision,
      predictions,
      requestedPredictedBytes,
      reason: denied
        ? decision.reason
        : "all schedulable nodes preserve the Hybrid physical safety reserve",
    };
  }

  async diagnostics() {
    await this.restorePolicy();
    const state = await this.prisma.workerReconciliationState.findFirst({
      where: { key: "capacityTelemetry" },
      orderBy: { updatedAt: "desc" },
      select: {
        lastResult: true,
        lastCompletedAt: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        lastError: true,
      },
    });
    const result =
      state?.lastResult &&
      typeof state.lastResult === "object" &&
      !Array.isArray(state.lastResult)
        ? (state.lastResult as Record<string, unknown>)
        : {};
    return {
      ...result,
      policy: this.policyService.serialize(this.policy()),
      telemetryState: state
        ? {
            lastCompletedAt: state.lastCompletedAt,
            lastSuccessAt: state.lastSuccessAt,
            lastFailureAt: state.lastFailureAt,
            lastError: state.lastError,
          }
        : null,
    };
  }

  async publishDiagnostics(workerId: string) {
    const startedAt = new Date();
    try {
      const diagnostics = await this.localDiagnostics();
      const completedAt = new Date();
      const lastResult = this.jsonValue(diagnostics);
      await this.prisma.workerReconciliationState.upsert({
        where: {
          workerId_key: {
            workerId,
            key: "capacityTelemetry",
          },
        },
        create: {
          workerId,
          key: "capacityTelemetry",
          lastStartedAt: startedAt,
          lastCompletedAt: completedAt,
          lastSuccessAt: completedAt,
          lastDurationMs: Math.max(
            0,
            completedAt.getTime() - startedAt.getTime(),
          ),
          lastResult,
          successCount: 1,
          failureCount: 0,
        },
        update: {
          lastStartedAt: startedAt,
          lastCompletedAt: completedAt,
          lastSuccessAt: completedAt,
          lastDurationMs: Math.max(
            0,
            completedAt.getTime() - startedAt.getTime(),
          ),
          lastResult,
          lastError: null,
          successCount: { increment: 1 },
        },
      });
      return diagnostics;
    } catch (error) {
      const completedAt = new Date();
      await this.prisma.workerReconciliationState.updateMany({
        where: { workerId, key: "capacityTelemetry" },
        data: {
          lastStartedAt: startedAt,
          lastCompletedAt: completedAt,
          lastFailureAt: completedAt,
          lastDurationMs: Math.max(
            0,
            completedAt.getTime() - startedAt.getTime(),
          ),
          lastError:
            error instanceof Error ? error.message : "Unknown capacity telemetry error",
          failureCount: { increment: 1 },
        },
      });
      throw error;
    }
  }

  private async localDiagnostics() {
    const policy = this.policy();
    const [runningApps, activeDeployments, latestNodes, observationCount] =
      await Promise.all([
        this.prisma.singleApp.findMany({
          where: {
            runtimeState: "Running",
            pendingDeletion: false,
            appGroup: { runtimeState: "Running" },
          },
          select: {
            id: true,
            name: true,
            memoryBytes: true,
            actualReplicas: true,
            desiredReplicas: true,
          },
        }),
        this.prisma.appGroupDeployment.findMany({
          where: {
            status: "Deploying",
            phase: {
              in: [
                "PreparingArtifacts",
                "GeneratingStack",
                "ApplyingStack",
                "WaitingForRollout",
                "Cleanup",
              ],
            },
          },
          select: { id: true, appGroupId: true, version: true },
        }),
        this.store.latestNodes(),
        this.store.observationCount(),
      ]);

    const historySince =
      Date.now() - policy.rareEventRetentionDays * 86_400_000;
    const histories = new Map<string, MemoryObservation[]>(
      await Promise.all(
        runningApps.map(async (app) => [
          app.id,
          await this.store.appHistory(app.id, historySince),
        ] as const),
      ),
    );
    const predictions = runningApps.map((app) => {
      const hard =
        app.memoryBytes *
        BigInt(Math.max(0, app.actualReplicas || app.desiredReplicas));
      return predictAppMemory(
        app.id,
        histories.get(app.id) ?? [],
        hard,
        policy,
      );
    });

    const nodeWindowSince =
      Date.now() - policy.predictionWindowDays * 86_400_000;
    let nodeP99 = 0n;
    for (const node of latestNodes) {
      const history = await this.store.nodeHistory(node.nodeId, nodeWindowSince);
      const sorted = history
        .map((item) => item.memoryCurrentBytes)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const p99 =
        sorted.length === 0
          ? node.memoryCurrentBytes
          : sorted[
              Math.min(
                sorted.length - 1,
                Math.ceil(sorted.length * 0.99) - 1,
              )
            ];
      if (p99 > nodeP99) nodeP99 = p99;
    }

    const hardLimitBytes = runningApps.reduce(
      (sum, app) =>
        sum +
        app.memoryBytes *
          BigInt(Math.max(0, app.actualReplicas || app.desiredReplicas)),
      0n,
    );
    const predictedDemandBytes = predictions.reduce(
      (sum, item) => sum + item.predictedBytes,
      0n,
    );
    const physicalMemoryTotalBytes = latestNodes.reduce(
      (sum, item) => sum + (item.nodeMemoryTotalBytes ?? 0n),
      0n,
    );
    const physicalMemoryAvailableBytes = latestNodes.reduce(
      (sum, item) => sum + (item.nodeMemoryAvailableBytes ?? 0n),
      0n,
    );
    const reserveFor = (node: MemoryObservation) => {
      const total = node.nodeMemoryTotalBytes ?? 0n;
      const percentage =
        total * BigInt(policy.nodeSafetyBufferPercent) / 100n;
      return percentage > policy.minimumSystemReserveBytes
        ? percentage
        : policy.minimumSystemReserveBytes;
    };
    const safetyReserveBytes = latestNodes.reduce(
      (sum, node) => sum + reserveFor(node),
      0n,
    );
    const minimumNodeHeadroomBytes =
      latestNodes.length === 0
        ? 0n
        : latestNodes.reduce<bigint | undefined>((minimum, node) => {
            const available = node.nodeMemoryAvailableBytes ?? 0n;
            const reserve = reserveFor(node);
            const headroom = available > reserve ? available - reserve : 0n;
            return minimum === undefined || headroom < minimum
              ? headroom
              : minimum;
          }, undefined) ?? 0n;
    const latestNode = [...latestNodes].sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
    )[0];

    return {
      policy: this.policyService.serialize(policy),
      latestNode: latestNode
        ? this.serializeObservation(latestNode)
        : null,
      nodes: latestNodes.map((item) => this.serializeObservation(item)),
      physicalMemoryTotalBytes: physicalMemoryTotalBytes.toString(),
      physicalMemoryAvailableBytes: physicalMemoryAvailableBytes.toString(),
      minimumNodeHeadroomBytes: minimumNodeHeadroomBytes.toString(),
      nodePredictedP99Bytes: nodeP99.toString(),
      hardLimitBytes: hardLimitBytes.toString(),
      predictedDemandBytes: predictedDemandBytes.toString(),
      safetyReserveBytes: safetyReserveBytes.toString(),
      activeDeploymentReservations: activeDeployments.map((deployment) => ({
        deploymentId: deployment.id,
        appGroupId: deployment.appGroupId,
        version: deployment.version,
      })),
      observations: observationCount.toString(),
      predictions: predictions.map((item) => ({
        ...item,
        currentBytes: item.currentBytes.toString(),
        averageBytes: item.averageBytes.toString(),
        p95Bytes: item.p95Bytes.toString(),
        p99Bytes: item.p99Bytes.toString(),
        max7dBytes: item.max7dBytes.toString(),
        max30dBytes: item.max30dBytes.toString(),
        max90dBytes: item.max90dBytes.toString(),
        startupPeakBytes: item.startupPeakBytes.toString(),
        predictedBytes: item.predictedBytes.toString(),
        recentOomEvents: item.recentOomEvents.toString(),
      })),
    };
  }

  private incrementalPrediction(
    snapshot: CapacityDeploymentSnapshot,
    histories: Map<string, MemoryObservation[]>,
    currentHardByApp: Map<string, bigint>,
    policy: CapacityPolicy,
  ) {
    if (snapshot.appGroup.runtimeState !== "Running") return 0n;
    let increment = 0n;
    for (const app of snapshot.singleApps) {
      if (
        app.runtimeState !== "Running" ||
        app.desiredReplicas <= 0
      ) {
        continue;
      }
      const hard =
        BigInt(app.resources.memoryBytes) *
        BigInt(Math.max(0, app.desiredReplicas));
      if (!app.id) {
        increment += hard;
        continue;
      }
      const target = predictAppMemory(
        app.id,
        histories.get(app.id) ?? [],
        hard,
        policy,
      ).predictedBytes;
      const currentHard = currentHardByApp.get(app.id) ?? 0n;
      const baseline =
        currentHard > 0n
          ? predictAppMemory(
              app.id,
              histories.get(app.id) ?? [],
              currentHard,
              policy,
            ).predictedBytes
          : 0n;
      if (target > baseline) increment += target - baseline;
    }
    return increment;
  }



  private jsonValue(value: unknown): Prisma.InputJsonValue {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    return normalized as Prisma.InputJsonValue;
  }

  private serializeObservation(point: MemoryObservation) {
    return {
      ...point,
      memoryCurrentBytes: point.memoryCurrentBytes.toString(),
      memoryPeakBytes: point.memoryPeakBytes.toString(),
      oomEvents: point.oomEvents.toString(),
      nodeMemoryAvailableBytes:
        point.nodeMemoryAvailableBytes?.toString() ?? null,
      nodeMemoryTotalBytes: point.nodeMemoryTotalBytes?.toString() ?? null,
    };
  }
}

@Injectable()
export class CapacityTelemetryReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastCollectedAt = 0;
  private readonly logger = new Logger(
    CapacityTelemetryReconcilerService.name,
  );

  constructor(
    private readonly telemetry: CapacityTelemetryService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    void this.telemetry.restorePolicy().then(() => this.collect(true));
    if (this.oneShot()) return;
    this.timer = setInterval(() => void this.collect(false), 10_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async collect(force = false) {
    if (this.running) return;
    this.running = true;
    try {
      await this.telemetry.restorePolicy();
      const intervalMs =
        this.telemetry.policy().telemetryIntervalSeconds * 1000;
      if (!force && Date.now() - this.lastCollectedAt < intervalMs) return;
      await this.telemetry.observeNow();
      const workerId =
        this.config.get<string>("WORKER_ID", "production-worker") ??
        "production-worker";
      await this.telemetry.publishDiagnostics(workerId);
      this.lastCollectedAt = Date.now();
    } catch (error) {
      this.logger.warn(
        "Capacity telemetry collection failed: " +
          (error instanceof Error ? error.message : "unknown error"),
      );
    } finally {
      this.running = false;
    }
  }

  private oneShot() {
    return ["1", "true", "yes", "on"].includes(
      (this.config.get<string>("WORKER_ONCE") ?? "")
        .trim()
        .toLowerCase(),
    );
  }
}
