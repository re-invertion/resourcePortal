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
  replicas: number;
};

type AdmissionAppEvidence = {
  appId: string;
  replicas: number;
  hardLimitBytes: bigint;
  predictedBytes: bigint;
  confidence: number;
  recentOomEvents: bigint;
};

type AdmissionNodeEvidence = {
  nodeId: string;
  observedAt: string;
  memoryCurrentBytes: bigint;
  memoryAvailableBytes: bigint;
  memoryTotalBytes: bigint;
  memoryPsiSomeAvg10?: number;
  memoryPsiFullAvg10?: number;
  p99Bytes: bigint;
  sampleCount: number;
};

type AdmissionEvidence = {
  generatedAt: string;
  nodes: AdmissionNodeEvidence[];
  apps: AdmissionAppEvidence[];
};

type AdmissionPrediction = Pick<
  AppMemoryPrediction,
  "appId" | "predictedBytes" | "confidence" | "recentOomEvents"
>;

export type HybridAdmissionEvaluation =
  | {
      usable: true;
      decision: HybridNodeDecision;
      predictions: AdmissionPrediction[];
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

    // Admission is intentionally driven by the worker-published PostgreSQL
    // snapshot. The API container is not allowed to mount or write the
    // storage-authoritative host path used by the worker's JSONL history.
    const evidence = await this.persistedAdmissionEvidence(policy);
    if (!evidence) {
      return {
        usable: false,
        reason: "fresh worker-published Hybrid admission telemetry is unavailable",
      };
    }

    const latestNodes = evidence.nodes.filter((node) => {
      const ageMs = Date.now() - Date.parse(node.observedAt);
      return (
        Number.isFinite(ageMs) &&
        ageMs >= 0 &&
        ageMs <= policy.maxTelemetryAgeSeconds * 1000
      );
    });
    const expectedNodes = Number(input.schedulableNodeCount);
    const nodeIds = new Set(latestNodes.map((node) => node.nodeId));
    if (
      !Number.isSafeInteger(expectedNodes) ||
      expectedNodes < 1 ||
      latestNodes.length !== expectedNodes ||
      nodeIds.size !== expectedNodes
    ) {
      return {
        usable: false,
        reason:
          "authenticated fresh per-node telemetry does not cover every schedulable Swarm node",
      };
    }

    const evidenceByApp = new Map(
      evidence.apps.map((item) => [item.appId, item] as const),
    );
    const currentByApp = new Map(
      input.runningApps.map((item) => [item.appId, item] as const),
    );
    const currentPredictionByApp = new Map<string, bigint>();
    const predictions: AdmissionPrediction[] = [];
    let sumAppPredictedBytes = 0n;
    let recentOomEvents = 0n;

    for (const running of input.runningApps) {
      const observed = evidenceByApp.get(running.appId);
      const predictedBytes = observed
        ? this.scalePrediction(
            observed.predictedBytes,
            observed.replicas,
            running.replicas,
            running.hardLimitBytes,
          )
        : running.hardLimitBytes;
      currentPredictionByApp.set(running.appId, predictedBytes);
      const confidence = observed?.confidence ?? 0;
      const appOom = observed?.recentOomEvents ?? 0n;
      predictions.push({
        appId: running.appId,
        predictedBytes,
        confidence,
        recentOomEvents: appOom,
      });
      sumAppPredictedBytes += predictedBytes;
      recentOomEvents += appOom;
    }

    const minAppConfidence =
      predictions.length === 0
        ? 0
        : Math.min(...predictions.map((item) => item.confidence));

    const requestedPredictedBytes = this.incrementalPrediction(
      input.snapshot,
      currentByApp,
      evidenceByApp,
      currentPredictionByApp,
    );
    const inFlightPredictedBytes = input.inFlightSnapshots.reduce(
      (sum, snapshot) =>
        sum +
        this.incrementalPrediction(
          snapshot,
          currentByApp,
          evidenceByApp,
          currentPredictionByApp,
        ),
      0n,
    );

    const decisions: Array<HybridNodeDecision & { nodeId: string }> = [];
    for (const latest of latestNodes) {
      const predictedExistingBytes = correlatedExistingDemand({
        sumAppPredictedBytes,
        nodeP99Bytes: latest.p99Bytes,
        currentAppMemoryBytes: latest.memoryCurrentBytes,
        minAppConfidence,
        nodeSampleCount: latest.sampleCount,
        policy,
      });
      const decision = evaluateHybridNodeAdmission({
        nodeMemoryTotalBytes: latest.memoryTotalBytes,
        nodeMemoryAvailableBytes: latest.memoryAvailableBytes,
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
    const admissionNodes: Array<Record<string, unknown>> = [];
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
      if (
        node.nodeMemoryAvailableBytes !== undefined &&
        node.nodeMemoryTotalBytes !== undefined
      ) {
        admissionNodes.push({
          nodeId: node.nodeId,
          observedAt: node.observedAt,
          memoryCurrentBytes: node.memoryCurrentBytes.toString(),
          memoryAvailableBytes: node.nodeMemoryAvailableBytes.toString(),
          memoryTotalBytes: node.nodeMemoryTotalBytes.toString(),
          memoryPsiSomeAvg10: node.memoryPsiSomeAvg10,
          memoryPsiFullAvg10: node.memoryPsiFullAvg10,
          p99Bytes: p99.toString(),
          sampleCount: history.length,
        });
      }
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
      admissionEvidence: {
        generatedAt: new Date().toISOString(),
        nodes: admissionNodes,
        apps: runningApps.flatMap((app, index) => {
          const replicas = Math.max(
            0,
            app.actualReplicas || app.desiredReplicas,
          );
          const prediction = predictions[index];
          if (replicas <= 0 || !prediction) return [];
          return [{
            appId: app.id,
            replicas,
            hardLimitBytes: (
              app.memoryBytes * BigInt(replicas)
            ).toString(),
            predictedBytes: prediction.predictedBytes.toString(),
            confidence: prediction.confidence,
            recentOomEvents: prediction.recentOomEvents.toString(),
          }];
        }),
      },
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
    currentByApp: Map<string, RunningAppCapacity>,
    evidenceByApp: Map<string, AdmissionAppEvidence>,
    currentPredictionByApp: Map<string, bigint>,
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
      const targetReplicas = Math.max(0, app.desiredReplicas);
      const targetHard =
        BigInt(app.resources.memoryBytes) * BigInt(targetReplicas);
      if (!app.id) {
        increment += targetHard;
        continue;
      }

      const current = currentByApp.get(app.id);
      if (!current) {
        increment += targetHard;
        continue;
      }
      const baseline =
        currentPredictionByApp.get(app.id) ?? current.hardLimitBytes;
      const observed = evidenceByApp.get(app.id);
      const target = observed
        ? this.scalePrediction(
            observed.predictedBytes,
            observed.replicas,
            targetReplicas,
            targetHard,
          )
        : targetHard;
      if (target > baseline) increment += target - baseline;
    }
    return increment;
  }

  private scalePrediction(
    predictedBytes: bigint,
    observedReplicas: number,
    targetReplicas: number,
    targetHardLimitBytes: bigint,
  ) {
    if (targetReplicas <= 0 || targetHardLimitBytes <= 0n) return 0n;
    if (
      observedReplicas <= 0 ||
      !Number.isSafeInteger(observedReplicas) ||
      predictedBytes <= 0n
    ) {
      return targetHardLimitBytes;
    }
    const divisor = BigInt(observedReplicas);
    const scaled =
      (predictedBytes * BigInt(targetReplicas) + divisor - 1n) / divisor;
    return scaled > targetHardLimitBytes ? targetHardLimitBytes : scaled;
  }

  private async persistedAdmissionEvidence(
    policy: CapacityPolicy,
  ): Promise<AdmissionEvidence | null> {
    const state = await this.prisma.workerReconciliationState.findFirst({
      where: { key: "capacityTelemetry" },
      orderBy: { updatedAt: "desc" },
      select: { lastResult: true, lastSuccessAt: true },
    });
    const successAt = state?.lastSuccessAt?.getTime();
    const snapshotAgeMs =
      successAt === undefined ? Number.NaN : Date.now() - successAt;
    if (
      !Number.isFinite(snapshotAgeMs) ||
      snapshotAgeMs < 0 ||
      snapshotAgeMs > policy.maxTelemetryAgeSeconds * 1000
    ) {
      return null;
    }
    if (
      !state?.lastResult ||
      typeof state.lastResult !== "object" ||
      Array.isArray(state.lastResult)
    ) {
      return null;
    }
    return this.parseAdmissionEvidence(
      (state.lastResult as Record<string, unknown>).admissionEvidence,
    );
  }

  private parseAdmissionEvidence(value: unknown): AdmissionEvidence | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const root = value as Record<string, unknown>;
    if (
      typeof root.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(root.generatedAt)) ||
      !Array.isArray(root.nodes) ||
      !Array.isArray(root.apps) ||
      root.nodes.length > 128 ||
      root.apps.length > 10_000
    ) {
      return null;
    }

    const decimal = (item: unknown): item is string =>
      typeof item === "string" && /^\d+$/.test(item);
    const finiteNonNegative = (item: unknown): item is number =>
      typeof item === "number" && Number.isFinite(item) && item >= 0;
    const nodes: AdmissionNodeEvidence[] = [];
    const nodeIds = new Set<string>();
    for (const raw of root.nodes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const node = raw as Record<string, unknown>;
      if (
        typeof node.nodeId !== "string" ||
        node.nodeId.length < 1 ||
        node.nodeId.length > 128 ||
        nodeIds.has(node.nodeId) ||
        typeof node.observedAt !== "string" ||
        !Number.isFinite(Date.parse(node.observedAt)) ||
        !decimal(node.memoryCurrentBytes) ||
        !decimal(node.memoryAvailableBytes) ||
        !decimal(node.memoryTotalBytes) ||
        !decimal(node.p99Bytes) ||
        !Number.isSafeInteger(node.sampleCount) ||
        Number(node.sampleCount) < 0 ||
        (node.memoryPsiSomeAvg10 !== undefined &&
          !finiteNonNegative(node.memoryPsiSomeAvg10)) ||
        (node.memoryPsiFullAvg10 !== undefined &&
          !finiteNonNegative(node.memoryPsiFullAvg10))
      ) {
        return null;
      }
      const memoryTotalBytes = BigInt(node.memoryTotalBytes);
      const memoryAvailableBytes = BigInt(node.memoryAvailableBytes);
      if (
        memoryTotalBytes <= 0n ||
        memoryAvailableBytes > memoryTotalBytes
      ) {
        return null;
      }
      nodeIds.add(node.nodeId);
      nodes.push({
        nodeId: node.nodeId,
        observedAt: node.observedAt,
        memoryCurrentBytes: BigInt(node.memoryCurrentBytes),
        memoryAvailableBytes,
        memoryTotalBytes,
        memoryPsiSomeAvg10:
          typeof node.memoryPsiSomeAvg10 === "number"
            ? node.memoryPsiSomeAvg10
            : undefined,
        memoryPsiFullAvg10:
          typeof node.memoryPsiFullAvg10 === "number"
            ? node.memoryPsiFullAvg10
            : undefined,
        p99Bytes: BigInt(node.p99Bytes),
        sampleCount: Number(node.sampleCount),
      });
    }

    const apps: AdmissionAppEvidence[] = [];
    const appIds = new Set<string>();
    for (const raw of root.apps) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const app = raw as Record<string, unknown>;
      if (
        typeof app.appId !== "string" ||
        app.appId.length < 1 ||
        app.appId.length > 160 ||
        appIds.has(app.appId) ||
        !Number.isSafeInteger(app.replicas) ||
        Number(app.replicas) <= 0 ||
        !decimal(app.hardLimitBytes) ||
        !decimal(app.predictedBytes) ||
        typeof app.confidence !== "number" ||
        !Number.isFinite(app.confidence) ||
        app.confidence < 0 ||
        app.confidence > 1 ||
        !decimal(app.recentOomEvents)
      ) {
        return null;
      }
      const hardLimitBytes = BigInt(app.hardLimitBytes);
      const predictedBytes = BigInt(app.predictedBytes);
      if (predictedBytes > hardLimitBytes) return null;
      appIds.add(app.appId);
      apps.push({
        appId: app.appId,
        replicas: Number(app.replicas),
        hardLimitBytes,
        predictedBytes,
        confidence: app.confidence,
        recentOomEvents: BigInt(app.recentOomEvents),
      });
    }

    return {
      generatedAt: root.generatedAt,
      nodes,
      apps,
    };
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
