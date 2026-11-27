import { Injectable, Optional } from "@nestjs/common";
import {
  DeploymentPhase,
  DeploymentStatus,
  Prisma,
} from "@prisma/client";
import {
  projectedCapacityFits,
  snapshotDemand,
  type CapacityDemand,
  type CapacitySnapshotSingleApp,
} from "./capacity.logic";
import { CapacityPolicyService } from "./capacity-policy.service";
import { CapacityTelemetryService } from "./capacity-telemetry.service";

const CAPACITY_LOCK_NAMESPACE = "resourceportal:capacity:swarm";
const SWARM_CLUSTER_SINGLETON_ID = "00000000-0000-0000-0000-000000000013";

const POSSIBLY_APPLIED_PHASES = [DeploymentPhase.ApplyingStack, DeploymentPhase.WaitingForRollout, DeploymentPhase.RollingBack, DeploymentPhase.Cleanup, DeploymentPhase.Completed];

const ADMITTED_PHASES = new Set<DeploymentPhase>([
  DeploymentPhase.PreparingArtifacts,
  DeploymentPhase.GeneratingStack,
  DeploymentPhase.ApplyingStack,
  DeploymentPhase.WaitingForRollout,
  DeploymentPhase.Cleanup,
  DeploymentPhase.RollingBack,
]);

export type CapacityErrorCode =
  | "InsufficientCapacity"
  | "PlatformUnavailable";

export type CapacityDeploymentSnapshot = {
  appGroup: {
    id: string;
    tenantId: string;
    runtimeState: string;
  };
  singleApps: Array<
    CapacitySnapshotSingleApp & {
      id?: string;
      name?: string;
      volumes: Array<{ volumeId: string }>;
      updatePolicy?: { order?: unknown; parallelism?: unknown };
    }
  >;
};

export type CapacityAdmissionResult =
  | {
      success: true;
      demand: CapacityDemand;
      occupied: CapacityDemand;
      supply: CapacityDemand;
    }
  | {
      success: false;
      errorCode: CapacityErrorCode;
      message: string;
    };

type PlatformCapacityRow = {
  health: string;
  availableCpuNano: bigint;
  availableMemoryBytes: bigint;
  schedulableNodeCount: bigint;
  schedulableNodeIds: string[];
};

type DeploymentReservationRow = {
  appGroupId: string;
  version: number;
  status: DeploymentStatus;
  phase: DeploymentPhase;
  stackConfig: string | null;
};

type RuntimeDemandOverride = {
  appGroupRuntimeState?: string;
  singleAppId?: string;
  singleAppRuntimeState?: string;
};

@Injectable()
export class CapacityPreflightService {
  constructor(
    @Optional() private readonly telemetry?: CapacityTelemetryService,
    @Optional() private readonly policy?: CapacityPolicyService,
  ) {}

  async hybridBudget(tx: Prisma.TransactionClient) {
    if (!this.telemetry) return null;
    const platform = await this.availablePlatformSupply(tx);
    if (!platform.success) return null;
    const [runningApps, inFlightSnapshots] = await Promise.all([
      this.currentRunningApps(tx),
      this.inFlightSnapshots(tx),
    ]);
    if (!inFlightSnapshots) return null;
    const result = await this.telemetry.evaluateAdmission({
      snapshot: { appGroup: { id: "", tenantId: "", runtimeState: "Stopped" }, singleApps: [] },
      runningApps,
      inFlightSnapshots,
      schedulableNodeIds: platform.schedulableNodeIds,
    });
    if (!result.usable) return null;
    return {
      deployableHeadroomBytes: (result.decision.deployableHeadroomBytes ?? 0n).toString(),
      predictedExistingGrowthBytes: result.decision.predictedExistingGrowthBytes.toString(),
      inFlightPredictedBytes: result.decision.inFlightPredictedBytes.toString(),
      allowed: result.decision.allowed,
      reason: result.decision.reason,
    };
  }

  async admitDeployment(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
  ): Promise<CapacityAdmissionResult> {
    await this.lockRuntimeMutation(tx);

    const platformResult = await this.availablePlatformSupply(tx);
    if (!platformResult.success) {
      return platformResult;
    }

    const storageFailure = await this.validateStorageBackends(tx, snapshot);
    if (storageFailure) {
      return storageFailure;
    }

    const occupiedResult = await this.occupiedCapacity(tx, snapshot.appGroup.id);
    if (!occupiedResult.success) {
      return occupiedResult;
    }

    const candidateDemand = snapshotDemand(snapshot);
    const previous = await tx.appGroupDeployment.findFirst({
      where: { appGroupId: snapshot.appGroup.id, status: DeploymentStatus.Succeeded },
      orderBy: { version: "desc" },
      select: { stackConfig: true },
    });
    let peakDemand = candidateDemand;
    if (previous) {
      const deployed = this.parseSnapshot(previous.stackConfig);
      if (!deployed || deployed.appGroup.id !== snapshot.appGroup.id ||
          deployed.appGroup.tenantId !== snapshot.appGroup.tenantId) {
        return this.platformUnavailable("Cannot account preceding deployment capacity");
      }
      const old = await this.succeededRuntimeDemand(tx, deployed);
      peakDemand = this.rolloutReservation(snapshot, candidateDemand, deployed, old);
    }
    return this.fitAdmission(
      tx,
      snapshot,
      platformResult.supply,
      occupiedResult.occupied,
      peakDemand,
      platformResult.schedulableNodeIds,
    );
  }

  async admitRuntimeStart(
    tx: Prisma.TransactionClient,
    input: { appGroupId: string; singleAppId?: string },
  ): Promise<CapacityAdmissionResult> {
    await this.lockRuntimeMutation(tx);

    const deployment = await tx.appGroupDeployment.findFirst({
      where: {
        appGroupId: input.appGroupId,
        status: DeploymentStatus.Succeeded,
      },
      orderBy: { version: "desc" },
      select: { stackConfig: true },
    });

    if (!deployment?.stackConfig) {
      return {
        success: true,
        demand: { cpuNano: 0n, memoryBytes: 0n },
        occupied: { cpuNano: 0n, memoryBytes: 0n },
        supply: { cpuNano: 0n, memoryBytes: 0n },
      };
    }

    const snapshot = this.parseSnapshot(deployment.stackConfig);
    if (!snapshot) {
      return this.platformUnavailable(
        `Cannot account deployment capacity for AppGroup ${input.appGroupId}`,
      );
    }

    const runtimeOverride: RuntimeDemandOverride = {
      appGroupRuntimeState: input.singleAppId ? undefined : "Running",
      singleAppId: input.singleAppId,
      singleAppRuntimeState: input.singleAppId ? "Running" : undefined,
    };
    const demand = await this.succeededRuntimeDemand(
      tx,
      snapshot,
      runtimeOverride,
    );
    const admissionSnapshot = await this.runtimeStartAdmissionSnapshot(
      tx,
      snapshot,
      runtimeOverride,
    );
    if (demand.cpuNano === 0n && demand.memoryBytes === 0n) {
      return {
        success: true,
        demand,
        occupied: { cpuNano: 0n, memoryBytes: 0n },
        supply: { cpuNano: 0n, memoryBytes: 0n },
      };
    }

    const platformResult = await this.availablePlatformSupply(tx);
    if (!platformResult.success) {
      return platformResult;
    }

    const storageFailure = await this.validateStorageBackends(tx, snapshot);
    if (storageFailure) {
      return storageFailure;
    }

    const occupiedResult = await this.occupiedCapacity(tx, input.appGroupId);
    if (!occupiedResult.success) {
      return occupiedResult;
    }

    return this.fitAdmission(
      tx,
      admissionSnapshot,
      platformResult.supply,
      occupiedResult.occupied,
      demand,
      platformResult.schedulableNodeIds,
      true,
    );
  }

  async lockRuntimeMutation(tx: Prisma.TransactionClient) {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK_NAMESPACE}, 0)) IS NULL AS "locked"`,
    );
  }

  private async availablePlatformSupply(
    tx: Prisma.TransactionClient,
  ): Promise<
    | {
        success: true;
        supply: CapacityDemand;
        schedulableNodeIds: string[];
      }
    | { success: false; errorCode: "PlatformUnavailable"; message: string }
  > {
    const platform = await this.platformCapacity(tx);
    if (!platform) {
      return this.platformUnavailable(
        "Docker Swarm infrastructure has not been reconciled",
      );
    }
    if (platform.health === "Unknown" || platform.health === "Unhealthy") {
      return this.platformUnavailable(
        `Docker Swarm health is ${platform.health}`,
      );
    }
    if (platform.schedulableNodeCount < 1n) {
      return this.platformUnavailable(
        "Docker Swarm has no schedulable Remote Location",
      );
    }
    if (
      BigInt(platform.schedulableNodeIds.length) !==
        platform.schedulableNodeCount ||
      new Set(platform.schedulableNodeIds).size !==
        platform.schedulableNodeIds.length
    ) {
      return this.platformUnavailable(
        "Docker Swarm schedulable node identity inventory is inconsistent",
      );
    }

    return {
      success: true,
      supply: {
        cpuNano: platform.availableCpuNano,
        memoryBytes: platform.availableMemoryBytes,
      },
      schedulableNodeIds: platform.schedulableNodeIds,
    };
  }

  private async fitAdmission(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
    supply: CapacityDemand,
    occupied: CapacityDemand,
    demand: CapacityDemand,
    schedulableNodeIds: string[],
    runtimeStart = false,
  ): Promise<CapacityAdmissionResult> {
    const fit = projectedCapacityFits(supply, occupied, demand);

    // CPU remains strict in every mode. Hybrid only changes how physical RAM
    // safety is evaluated; it never relaxes CPU or GPU/quota protections.
    if (!fit.fits && fit.resource === "cpu") {
      return this.strictCapacityFailure(fit.resource, supply, occupied, demand);
    }

    const configuredMode = this.policy?.current().mode;
    let strictFallbackReason: string | undefined;
    if (configuredMode === "Hybrid" && !this.telemetry) {
      strictFallbackReason = "TelemetryServiceUnavailable";
    }
    if (configuredMode === "Hybrid" && this.telemetry) {
      const [runningApps, inFlightSnapshots] = await Promise.all([
        this.currentRunningApps(tx),
        this.inFlightSnapshots(tx, snapshot.appGroup.id),
      ]);
      if (!inFlightSnapshots) return this.platformUnavailable("Cannot account active deployment capacity");
      const hybrid = await this.telemetry.evaluateAdmission({
        snapshot,
        runningApps,
        inFlightSnapshots,
        schedulableNodeIds,
        runtimeStart,
      });
      if (hybrid.usable) {
        if (hybrid.decision.allowed) {
          return { success: true, demand, occupied, supply };
        }
        const d = hybrid.decision;
        return {
          success: false,
          errorCode: "InsufficientCapacity",
          message:
            "Insufficient platform memory capacity in Hybrid mode (" +
            "reason=" + d.reason +
            ", memAvailable=" + d.nodeMemoryAvailableBytes + " bytes" +
            ", predictedExistingGrowth=" + d.predictedExistingGrowthBytes + " bytes" +
            ", requestedPredicted=" + d.requestedPredictedBytes + " bytes" +
            ", inFlightPredicted=" + d.inFlightPredictedBytes + " bytes" +
            ", safetyReserve=" + d.safetyReserveBytes + " bytes" +
            ", remainingAfterAdmission=" + d.remainingAfterAdmissionBytes + " bytes)",
        };
      }
      // No guessing: missing/stale/incomplete Hybrid telemetry falls back to
      // declared reservations. Preserve an allow-listed explanation for the
      // operator instead of presenting this as normal Strict policy.
      strictFallbackReason = this.hybridFallbackReason(hybrid.reason);
    }

    if (fit.fits) {
      return { success: true, demand, occupied, supply };
    }
    return this.strictCapacityFailure(fit.resource, supply, occupied, demand, strictFallbackReason);
  }

  private hybridFallbackReason(reason: string): string {
    // Do not echo unchecked telemetry text or resource identifiers in a
    // tenant-visible admission error. Reasons come from fixed internal states.
    if (reason === "fresh worker-published Hybrid admission telemetry is unavailable") return "WorkerTelemetryUnavailableOrStale";
    if (reason === "authenticated fresh per-node telemetry does not cover every schedulable Swarm node") return "IncompleteNodeCoverage";
    if (reason === "schedulable Swarm node identity inventory is invalid") return "InvalidNodeInventory";
    if (reason === "node capacity decision is unavailable") return "NodeDecisionUnavailable";
    if (reason === "capacity mode is Strict") return "EffectivePolicyStrict";
    return "HybridEvidenceUnavailable";
  }

  private strictCapacityFailure(
    resource: "cpu" | "memory",
    supply: CapacityDemand,
    occupied: CapacityDemand,
    demand: CapacityDemand,
    strictFallbackReason?: string,
  ): CapacityAdmissionResult {
    const field = resource === "cpu" ? "cpuNano" : "memoryBytes";
    const unit = resource === "cpu" ? "NanoCPU" : "bytes";
    const available = supply[field] > occupied[field]
      ? supply[field] - occupied[field]
      : 0n;
    return {
      success: false,
      errorCode: "InsufficientCapacity",
      message:
        "Insufficient platform " + resource +
        " capacity (requested=" + demand[field] + " " + unit +
        ", reserved=" + occupied[field] + " " + unit +
        ", allocatable=" + supply[field] + " " + unit +
        ", unreserved=" + available + " " + unit + ")" +
        (resource === "memory" && strictFallbackReason
          ? " [admissionMode=StrictFallback, reason=" + strictFallbackReason +
            "; Hybrid telemetry cannot be used; retry after worker telemetry recovers]"
          : ""),
    };
  }

  private async runtimeStartAdmissionSnapshot(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
    override: RuntimeDemandOverride,
  ): Promise<CapacityDeploymentSnapshot> {
    const singleAppIds = snapshot.singleApps
      .map((singleApp) => singleApp.id)
      .filter((id): id is string => typeof id === "string");
    if (singleAppIds.length !== snapshot.singleApps.length) {
      return {
        ...snapshot,
        appGroup: {
          ...snapshot.appGroup,
          runtimeState:
            override.appGroupRuntimeState ?? snapshot.appGroup.runtimeState,
        },
        singleApps: snapshot.singleApps.map((singleApp) => ({
          ...singleApp,
          runtimeState:
            override.singleAppId === singleApp.id
              ? (override.singleAppRuntimeState ?? singleApp.runtimeState)
              : singleApp.runtimeState,
        })),
      };
    }

    const [appGroup, currentSingleApps] = await Promise.all([
      tx.appGroup.findUnique({
        where: { id: snapshot.appGroup.id },
        select: { runtimeState: true },
      }),
      tx.singleApp.findMany({
        where: {
          appGroupId: snapshot.appGroup.id,
          id: { in: singleAppIds },
        },
        select: {
          id: true,
          runtimeState: true,
          actualReplicas: true,
        },
      }),
    ]);
    const currentById = new Map(
      currentSingleApps.map((singleApp) => [singleApp.id, singleApp]),
    );
    const appGroupRuntimeState =
      override.appGroupRuntimeState ??
      appGroup?.runtimeState ??
      snapshot.appGroup.runtimeState;

    return {
      ...snapshot,
      appGroup: {
        ...snapshot.appGroup,
        runtimeState: appGroupRuntimeState,
      },
      singleApps: snapshot.singleApps.map((singleApp) => {
        const current = singleApp.id
          ? currentById.get(singleApp.id)
          : undefined;
        const runtimeState =
          override.singleAppId === singleApp.id
            ? (override.singleAppRuntimeState ??
              current?.runtimeState ??
              singleApp.runtimeState)
            : (current?.runtimeState ?? singleApp.runtimeState);
        const observedReplicas = Math.max(
          0,
          current?.actualReplicas ?? 0,
        );
        const deployedReplicas = Math.max(0, singleApp.desiredReplicas);
        const runnable =
          appGroupRuntimeState === "Running" && runtimeState === "Running";
        return {
          ...singleApp,
          runtimeState: runnable ? "Running" : "Stopped",
          desiredReplicas: runnable
            ? Math.max(deployedReplicas, observedReplicas)
            : observedReplicas,
        };
      }),
    };
  }

  private async currentRunningApps(
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ appId: string; hardLimitBytes: bigint; replicas: number; serviceName?: string; reverseStopFirst?: boolean; generation?: string }>> {
    const rows = await tx.singleApp.findMany({
      where: {
        OR: [
          { runtimeState: "Running", pendingDeletion: false, appGroup: { runtimeState: "Running" } },
          { actualReplicas: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        appGroupId: true,
        memoryBytes: true,
        desiredReplicas: true,
        actualReplicas: true,
        runtimeState: true,
        pendingDeletion: true,
        appGroup: { select: { runtimeState: true } },
      },
    });
    if (rows.length === 0) return [];

    const appGroupIds = [...new Set(rows.map((item) => item.appGroupId))];
    const deployments = await tx.appGroupDeployment.findMany({
      where: {
        appGroupId: { in: appGroupIds },
        status: DeploymentStatus.Succeeded,
      },
      orderBy: { version: "desc" },
      select: {
        appGroupId: true,
        version: true,
        completedAt: true,
        stackConfig: true,
      },
    });
    const latestSeen = new Set<string>();
    const deployedByApp = new Map<
      string,
      { replicas: number; memoryBytes: bigint; serviceName?: string; reverseStopFirst?: boolean; generation?: string }
    >();
    for (const deployment of deployments) {
      if (latestSeen.has(deployment.appGroupId)) continue;
      latestSeen.add(deployment.appGroupId);
      const parsed = this.parseSnapshot(deployment.stackConfig);
      if (!parsed) continue;
      for (const singleApp of parsed.singleApps) {
        if (!singleApp.id) continue;
        try {
          deployedByApp.set(singleApp.id, {
            replicas: Math.max(0, singleApp.desiredReplicas),
            memoryBytes: BigInt(singleApp.resources.memoryBytes),
            serviceName: singleApp.name,
            reverseStopFirst: singleApp.updatePolicy?.order === "stop-first",
            generation: deployment.completedAt ? `${deployment.appGroupId}:${deployment.version}:${deployment.completedAt.toISOString()}` : undefined,
          });
        } catch {
          // Fall back to the current row below. Admission remains conservative.
        }
      }
    }

    return rows.flatMap((item) => {
      const deployed = deployedByApp.get(item.id);
      const running = item.runtimeState === "Running" &&
        !item.pendingDeletion && item.appGroup.runtimeState === "Running";
      const replicas = Math.max(
        0,
        item.actualReplicas,
        running ? (deployed?.replicas ?? item.desiredReplicas) : 0,
      );
      if (replicas <= 0) return [];
      const memoryBytes = deployed?.memoryBytes ?? item.memoryBytes;
      return [{
        appId: item.id,
        hardLimitBytes: memoryBytes * BigInt(replicas),
        replicas,
        serviceName: deployed?.serviceName,
        reverseStopFirst: deployed?.reverseStopFirst,
        generation: deployed?.generation,
      }];
    });
  }

  private async inFlightSnapshots(
    tx: Prisma.TransactionClient,
    excludedAppGroupId?: string,
  ): Promise<CapacityDeploymentSnapshot[] | null> {
    const rows = await tx.appGroupDeployment.findMany({
      where: {
        ...(excludedAppGroupId ? { appGroupId: { not: excludedAppGroupId } } : {}),
        OR: [
          { status: { in: [DeploymentStatus.Deploying, DeploymentStatus.RollingBack] }, phase: { in: Array.from(ADMITTED_PHASES) } },
          { status: DeploymentStatus.RollbackFailed },
          { status: DeploymentStatus.Failed, phase: { in: POSSIBLY_APPLIED_PHASES } },
        ],
      },
      select: { stackConfig: true, appGroupId: true, version: true, status: true },
    });
    const failed = rows.filter(row => row.status === DeploymentStatus.RollbackFailed || row.status === DeploymentStatus.Failed);
    const latestSucceeded = failed.length ? await tx.appGroupDeployment.findMany({
      where: { appGroupId: { in: failed.map(row => row.appGroupId) }, status: DeploymentStatus.Succeeded },
      select: { appGroupId: true, version: true },
    }) : [];
    const snapshots = rows.filter(row => (row.status !== DeploymentStatus.RollbackFailed && row.status !== DeploymentStatus.Failed) ||
      !latestSucceeded.some(success => success.appGroupId === row.appGroupId && success.version > row.version)
    ).map((row) => this.parseSnapshot(row.stackConfig));
    if (snapshots.some(row => row === null)) return null;
    return snapshots.filter((row): row is CapacityDeploymentSnapshot => row !== null);
  }

  private async platformCapacity(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<PlatformCapacityRow[]>(Prisma.sql`
      SELECT
        c."health"::text AS "health",
        COALESCE(SUM(r."availableCpuNano") FILTER (
          WHERE r."status" = 'Ready'
            AND r."availability" = 'Active'
            AND r."maintenance" = false
            AND r."health" IN ('Healthy', 'Degraded')
        ), 0)::bigint AS "availableCpuNano",
        COALESCE(SUM(r."availableMemoryBytes") FILTER (
          WHERE r."status" = 'Ready'
            AND r."availability" = 'Active'
            AND r."maintenance" = false
            AND r."health" IN ('Healthy', 'Degraded')
        ), 0)::bigint AS "availableMemoryBytes",
        COUNT(*) FILTER (
          WHERE r."status" = 'Ready'
            AND r."availability" = 'Active'
            AND r."maintenance" = false
            AND r."health" IN ('Healthy', 'Degraded')
        )::bigint AS "schedulableNodeCount",
        COALESCE(
          ARRAY_AGG(r."swarmNodeId" ORDER BY r."swarmNodeId") FILTER (
            WHERE r."status" = 'Ready'
              AND r."availability" = 'Active'
              AND r."maintenance" = false
              AND r."health" IN ('Healthy', 'Degraded')
          ),
          ARRAY[]::text[]
        ) AS "schedulableNodeIds"
      FROM "SwarmCluster" c
      LEFT JOIN "RemoteLocation" r ON TRUE
      WHERE c."id" = ${SWARM_CLUSTER_SINGLETON_ID}::uuid
      GROUP BY c."id", c."health"
      LIMIT 1
    `);

    return rows[0] ?? null;
  }

  private async validateStorageBackends(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
  ) {
    const volumeIds = Array.from(
      new Set(
        snapshot.singleApps.flatMap((singleApp) =>
          singleApp.volumes.map((volume) => volume.volumeId),
        ),
      ),
    );
    if (volumeIds.length === 0) {
      return null;
    }

    const volumes = await tx.volume.findMany({
      where: {
        id: { in: volumeIds },
        tenantId: snapshot.appGroup.tenantId,
      },
      select: {
        id: true,
        storageBackend: {
          select: {
            id: true,
            status: true,
            health: true,
            maintenance: true,
            capacityTotal: true,
            capacityAvailable: true,
          },
        },
      },
    });

    if (volumes.length !== volumeIds.length) {
      return this.platformUnavailable(
        "A referenced Volume or StorageBackend is unavailable",
      );
    }

    const checked = new Set<string>();
    for (const volume of volumes) {
      const backend = volume.storageBackend;
      if (checked.has(backend.id)) {
        continue;
      }
      checked.add(backend.id);

      if (backend.maintenance) {
        return this.platformUnavailable(
          `StorageBackend ${backend.id} is in maintenance`,
        );
      }
      if (backend.status !== "Ready") {
        return this.platformUnavailable(
          `StorageBackend ${backend.id} is not Ready`,
        );
      }
      if (backend.health !== "Healthy" && backend.health !== "Degraded") {
        return this.platformUnavailable(
          `StorageBackend ${backend.id} health is ${backend.health}`,
        );
      }
      if (
        backend.capacityTotal === null ||
        backend.capacityAvailable === null
      ) {
        return this.platformUnavailable(
          `StorageBackend ${backend.id} capacity is unavailable`,
        );
      }
    }

    return null;
  }

  private async occupiedCapacity(
    tx: Prisma.TransactionClient,
    excludedAppGroupId: string,
  ): Promise<
    | { success: true; occupied: CapacityDemand }
    | { success: false; errorCode: "PlatformUnavailable"; message: string }
  > {
    const deployments = await tx.appGroupDeployment.findMany({
      where: {
        appGroupId: { not: excludedAppGroupId },
        OR: [
          { status: DeploymentStatus.Succeeded },
          { status: DeploymentStatus.Deploying },
          { status: DeploymentStatus.RollingBack },
          { status: DeploymentStatus.RollbackFailed },
          { status: DeploymentStatus.Failed, phase: { in: POSSIBLY_APPLIED_PHASES } },
        ],
      },
      select: {
        appGroupId: true,
        version: true,
        status: true,
        phase: true,
        stackConfig: true,
      },
    });

    const byAppGroup = new Map<string, DeploymentReservationRow[]>();
    for (const deployment of deployments) {
      const rows = byAppGroup.get(deployment.appGroupId) ?? [];
      rows.push(deployment);
      byAppGroup.set(deployment.appGroupId, rows);
    }

    let occupied: CapacityDemand = { cpuNano: 0n, memoryBytes: 0n };
    for (const rows of byAppGroup.values()) {
      const succeeded = rows
        .filter(row => row.status === DeploymentStatus.Succeeded)
        .sort((a, b) => b.version - a.version)[0];
      const active = rows.filter(row =>
        (!succeeded || row.version > succeeded.version) &&
        (row.status === DeploymentStatus.RollbackFailed ||
          (row.status === DeploymentStatus.Failed && POSSIBLY_APPLIED_PHASES.includes(row.phase)) ||
          ((row.status === DeploymentStatus.Deploying || row.status === DeploymentStatus.RollingBack) &&
            ADMITTED_PHASES.has(row.phase))),
      );
      let demand: CapacityDemand = { cpuNano: 0n, memoryBytes: 0n };
      const previous = succeeded ? this.parseSnapshot(succeeded.stackConfig) : null;
      if (succeeded && !previous) {
        return this.platformUnavailable(
          `Cannot account previous capacity for AppGroup ${succeeded.appGroupId}`,
        );
      }
      if (previous) demand = await this.succeededRuntimeDemand(tx, previous);
      for (const row of active) {
        const parsed = this.parseSnapshot(row.stackConfig);
        if (!parsed) {
          return this.platformUnavailable(
            `Cannot account deployment capacity for AppGroup ${row.appGroupId}`,
          );
        }
        const target = snapshotDemand(parsed);
        // Multiple unresolved attempts may leave distinct service identities
        // live. Only a single ordered replacement may credit the baseline.
        if (active.length === 1 && previous && row.status !== DeploymentStatus.RollbackFailed && row.status !== DeploymentStatus.Failed) {
          demand = this.rolloutReservation(parsed, target, previous, demand);
        } else {
          demand = { cpuNano: demand.cpuNano + target.cpuNano, memoryBytes: demand.memoryBytes + target.memoryBytes };
        }
      }
      occupied = {
        cpuNano: occupied.cpuNano + demand.cpuNano,
        memoryBytes: occupied.memoryBytes + demand.memoryBytes,
      };
    }

    return { success: true, occupied };
  }

  private rolloutReservation(
    snapshot: CapacityDeploymentSnapshot,
    target: CapacityDemand,
    deployed: CapacityDeploymentSnapshot,
    previous: CapacityDemand,
  ): CapacityDemand {
    // A group-wide maximum alone is unsafe when some services grow while
    // others shrink. Without proof of an ordered replacement, reserve both
    // allocations. Credit the old allocation only for a structurally
    // non-increasing, explicit stop-first replacement of the same services.
    const oldById = new Map(deployed.singleApps.map(app => [app.id, app]));
    const nonIncreasing = snapshot.appGroup.runtimeState === "Running" &&
      deployed.appGroup.runtimeState === "Running" &&
      snapshot.singleApps.length === deployed.singleApps.length &&
      oldById.size === deployed.singleApps.length &&
      new Set(snapshot.singleApps.map(app => app.id)).size === snapshot.singleApps.length &&
      snapshot.singleApps.every(app => {
        const old = oldById.get(app.id);
        if (!app.id || !old || !app.name || !old.name ||
            app.name.replaceAll("-", "_") !== old.name.replaceAll("-", "_") ||
            app.updatePolicy?.order !== "stop-first" || old.updatePolicy?.order !== "stop-first" ||
            app.runtimeState !== old.runtimeState ||
            app.desiredReplicas > old.desiredReplicas ||
            app.resources.gpu !== old.resources.gpu) return false;
        const nextUnit = snapshotDemand({ appGroup: { runtimeState: "Running" },
          singleApps: [{ ...app, runtimeState: "Running", desiredReplicas: 1 }] });
        const oldUnit = snapshotDemand({ appGroup: { runtimeState: "Running" },
          singleApps: [{ ...old, runtimeState: "Running", desiredReplicas: 1 }] });
        return nextUnit.cpuNano <= oldUnit.cpuNano &&
          nextUnit.memoryBytes <= oldUnit.memoryBytes;
      });
    return {
      cpuNano: nonIncreasing ? (target.cpuNano > previous.cpuNano ? target.cpuNano : previous.cpuNano) : target.cpuNano + previous.cpuNano,
      memoryBytes: nonIncreasing ? (target.memoryBytes > previous.memoryBytes ? target.memoryBytes : previous.memoryBytes) : target.memoryBytes + previous.memoryBytes,
    };
  }

  private async succeededRuntimeDemand(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
    override?: RuntimeDemandOverride,
  ): Promise<CapacityDemand> {
    const singleAppIds = snapshot.singleApps
      .map((singleApp) => singleApp.id)
      .filter((id): id is string => typeof id === "string");
    if (singleAppIds.length !== snapshot.singleApps.length) {
      return snapshotDemand(snapshot);
    }

    const appGroup = await tx.appGroup.findUnique({
      where: { id: snapshot.appGroup.id },
      select: { runtimeState: true },
    });
    if (!appGroup) {
      return snapshotDemand(snapshot);
    }

    const currentSingleApps = await tx.singleApp.findMany({
      where: {
        appGroupId: snapshot.appGroup.id,
        id: { in: singleAppIds },
      },
      select: {
        id: true,
        runtimeState: true,
        desiredReplicas: true,
        actualReplicas: true,
      },
    });
    const currentById = new Map(
      currentSingleApps.map((singleApp) => [singleApp.id, singleApp]),
    );
    const appGroupRuntimeState =
      override?.appGroupRuntimeState ?? appGroup.runtimeState;

    let demand: CapacityDemand = { cpuNano: 0n, memoryBytes: 0n };
    for (const singleApp of snapshot.singleApps) {
      const current = singleApp.id ? currentById.get(singleApp.id) : undefined;
      if (!current) {
        const fallback = snapshotDemand({
          appGroup: { runtimeState: snapshot.appGroup.runtimeState },
          singleApps: [singleApp],
        });
        demand = {
          cpuNano: demand.cpuNano + fallback.cpuNano,
          memoryBytes: demand.memoryBytes + fallback.memoryBytes,
        };
        continue;
      }

      const currentRuntimeState =
        override?.singleAppId === singleApp.id
          ? (override?.singleAppRuntimeState ?? current.runtimeState)
          : current.runtimeState;
      // Only the last successfully deployed snapshot defines the desired
      // allocation. A draft replica edit has not reached the Swarm yet.
      // Runtime start of a previously stopped snapshot must still reserve
      // the deployed replica count, not bypass admission with zero demand.
      const deployedReplicas = Math.max(0, singleApp.desiredReplicas);
      const liveRunning =
        appGroupRuntimeState === "Running" && currentRuntimeState === "Running";
      const replicas = liveRunning
        ? Math.max(deployedReplicas, Math.max(0, current.actualReplicas))
        : Math.max(0, current.actualReplicas);
      const liveDemand = snapshotDemand({
        appGroup: { runtimeState: "Running" },
        singleApps: [
          {
            runtimeState: "Running",
            desiredReplicas: replicas,
            resources: singleApp.resources,
          },
        ],
      });
      demand = {
        cpuNano: demand.cpuNano + liveDemand.cpuNano,
        memoryBytes: demand.memoryBytes + liveDemand.memoryBytes,
      };
    }

    return demand;
  }

  private parseSnapshot(stackConfig: string | null): CapacityDeploymentSnapshot | null {
    if (!stackConfig) {
      return null;
    }
    try {
      const parsed = JSON.parse(stackConfig) as CapacityDeploymentSnapshot;
      if (
        !parsed?.appGroup ||
        typeof parsed.appGroup.id !== "string" ||
        typeof parsed.appGroup.runtimeState !== "string" ||
        !Array.isArray(parsed.singleApps) ||
        parsed.singleApps.some(app =>
          !app || !["Running", "Stopped"].includes(app.runtimeState) ||
          !Number.isSafeInteger(app.desiredReplicas) || app.desiredReplicas < 0 ||
          !app.resources ||
          typeof app.resources.memoryBytes !== "string" ||
          !/^[0-9]+$/.test(app.resources.memoryBytes) ||
          !Array.isArray(app.volumes)
        )
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private platformUnavailable(message: string) {
    return {
      success: false as const,
      errorCode: "PlatformUnavailable" as const,
      message,
    };
  }
}
