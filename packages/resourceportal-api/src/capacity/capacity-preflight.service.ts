import { Injectable } from "@nestjs/common";
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

const CAPACITY_LOCK_NAMESPACE = "resourceportal:capacity:swarm";
const SWARM_CLUSTER_SINGLETON_ID = "00000000-0000-0000-0000-000000000013";

const ADMITTED_PHASES = new Set<DeploymentPhase>([
  DeploymentPhase.PreparingArtifacts,
  DeploymentPhase.GeneratingStack,
  DeploymentPhase.ApplyingStack,
  DeploymentPhase.WaitingForRollout,
  DeploymentPhase.Cleanup,
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
      volumes: Array<{ volumeId: string }>;
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
  async admitDeployment(
    tx: Prisma.TransactionClient,
    snapshot: CapacityDeploymentSnapshot,
  ): Promise<CapacityAdmissionResult> {
    await this.lockCapacity(tx);

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

    return this.fitAdmission(
      platformResult.supply,
      occupiedResult.occupied,
      snapshotDemand(snapshot),
    );
  }

  async admitRuntimeStart(
    tx: Prisma.TransactionClient,
    input: { appGroupId: string; singleAppId?: string },
  ): Promise<CapacityAdmissionResult> {
    await this.lockCapacity(tx);

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

    const demand = await this.succeededRuntimeDemand(tx, snapshot, {
      appGroupRuntimeState: input.singleAppId ? undefined : "Running",
      singleAppId: input.singleAppId,
      singleAppRuntimeState: input.singleAppId ? "Running" : undefined,
    });
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
      platformResult.supply,
      occupiedResult.occupied,
      demand,
    );
  }

  private async lockCapacity(tx: Prisma.TransactionClient) {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK_NAMESPACE}, 0)) IS NULL AS "locked"`,
    );
  }

  private async availablePlatformSupply(
    tx: Prisma.TransactionClient,
  ): Promise<
    | { success: true; supply: CapacityDemand }
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

    return {
      success: true,
      supply: {
        cpuNano: platform.availableCpuNano,
        memoryBytes: platform.availableMemoryBytes,
      },
    };
  }

  private fitAdmission(
    supply: CapacityDemand,
    occupied: CapacityDemand,
    demand: CapacityDemand,
  ): CapacityAdmissionResult {
    const fit = projectedCapacityFits(supply, occupied, demand);
    if (!fit.fits) {
      return {
        success: false,
        errorCode: "InsufficientCapacity",
        message: `Insufficient platform ${fit.resource} capacity`,
      };
    }

    return {
      success: true,
      demand,
      occupied,
      supply,
    };
  }

  private async platformCapacity(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<PlatformCapacityRow[]>(Prisma.sql`
      SELECT
        c."health"::text AS "health",
        COALESCE(SUM(r."availableCpuNano"), 0)::bigint AS "availableCpuNano",
        COALESCE(SUM(r."availableMemoryBytes"), 0)::bigint AS "availableMemoryBytes",
        COUNT(*) FILTER (
          WHERE r."status" = 'Ready'
            AND r."availability" = 'Active'
            AND r."maintenance" = false
            AND r."health" IN ('Healthy', 'Degraded')
        )::bigint AS "schedulableNodeCount"
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
      const active = rows
        .filter(
          (row) =>
            row.status === DeploymentStatus.Deploying &&
            ADMITTED_PHASES.has(row.phase),
        )
        .sort((a, b) => b.version - a.version)[0];
      const succeeded = rows
        .filter((row) => row.status === DeploymentStatus.Succeeded)
        .sort((a, b) => b.version - a.version)[0];
      const selected = active ?? succeeded;
      if (!selected) {
        continue;
      }

      const parsed = this.parseSnapshot(selected.stackConfig);
      if (!parsed) {
        return this.platformUnavailable(
          `Cannot account deployment capacity for AppGroup ${selected.appGroupId}`,
        );
      }
      const demand = active
        ? snapshotDemand(parsed)
        : await this.succeededRuntimeDemand(tx, parsed);
      occupied = {
        cpuNano: occupied.cpuNano + demand.cpuNano,
        memoryBytes: occupied.memoryBytes + demand.memoryBytes,
      };
    }

    return { success: true, occupied };
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
      const deployedReplicas =
        snapshot.appGroup.runtimeState === "Running" &&
        singleApp.runtimeState === "Running"
          ? Math.max(0, singleApp.desiredReplicas)
          : 0;
      const liveRunning =
        appGroupRuntimeState === "Running" && currentRuntimeState === "Running";
      const replicas = liveRunning
        ? Math.max(
            deployedReplicas,
            Math.max(0, current.desiredReplicas),
            Math.max(0, current.actualReplicas),
          )
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
        !Array.isArray(parsed.singleApps)
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