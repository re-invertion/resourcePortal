import { Injectable } from "@nestjs/common";
import { DeploymentStatus, HealthState, RuntimeState } from "@prisma/client";
import {
  deriveAppGroupDriftStatus,
  ExpectedRuntimeService,
  ObservedRuntimeService,
} from "../app-groups/runtime-drift";
import { mapAppGroup } from "../app-groups/app-groups.view";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { StackRuntimeService } from "./stack-runtime.service";

type DriftSnapshot = {
  singleApps: Array<{
    id: string;
    name: string;
    image: string;
    desiredReplicas: number;
  }>;
};

type AppGroupCandidate = {
  id: string;
  status: string;
  runtimeState: RuntimeState;
  currentDeploymentVersion: number | null;
  tenant: {
    status: string;
    billing: { balance: { lte(value: number): boolean } } | null;
  };
  singleApps: Array<{ id: string; runtimeState: RuntimeState }>;
};

type ReconcileStats = {
  scanned: number;
  inSync: number;
  drifted: number;
  unknown: number;
};

@Injectable()
export class RuntimeDriftReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stackRuntime: StackRuntimeService,
    private readonly maintenance: PlatformMaintenanceService,
  ) {}

  async reconcileBatch(limit = 50) {
    const [appGroups, maintenanceState] = await Promise.all([
      this.loadBatch(limit),
      this.maintenance.getState(),
    ]);
    return this.reconcileCandidates(appGroups, maintenanceState.enabled);
  }

  async reconcileAll(pageSize = 100) {
    const safePageSize = Math.min(500, Math.max(1, Math.floor(pageSize)));
    const maintenanceState = await this.maintenance.getState();
    const total: ReconcileStats = {
      scanned: 0,
      inSync: 0,
      drifted: 0,
      unknown: 0,
    };
    let cursor: string | undefined;

    while (true) {
      const appGroups = await this.prisma.appGroup.findMany({
        where: {
          currentDeploymentVersion: { not: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: safePageSize,
        include: this.appGroupInclude(),
      });
      if (appGroups.length === 0) break;

      const page = await this.reconcileCandidates(
        appGroups,
        maintenanceState.enabled,
      );
      total.scanned += page.scanned;
      total.inSync += page.inSync;
      total.drifted += page.drifted;
      total.unknown += page.unknown;
      cursor = appGroups.at(-1)?.id;
      if (appGroups.length < safePageSize) break;
    }

    return total;
  }

  private loadBatch(limit: number) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.prisma.appGroup.findMany({
      where: { currentDeploymentVersion: { not: null } },
      orderBy: { updatedAt: "asc" },
      take: safeLimit,
      include: this.appGroupInclude(),
    }) as unknown as Promise<AppGroupCandidate[]>;
  }

  private appGroupInclude() {
    return {
      tenant: {
        select: {
          status: true,
          billing: { select: { balance: true } },
        },
      },
      singleApps: {
        select: {
          id: true,
          runtimeState: true,
        },
      },
    } as const;
  }

  private async reconcileCandidates(
    appGroups: AppGroupCandidate[],
    platformMaintenance: boolean,
  ): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      scanned: appGroups.length,
      inSync: 0,
      drifted: 0,
      unknown: 0,
    };

    for (const appGroup of appGroups) {
      const driftStatus = await this.reconcileAppGroup(
        appGroup,
        platformMaintenance,
      );
      if (driftStatus === "InSync") stats.inSync += 1;
      else if (driftStatus === "Drifted") stats.drifted += 1;
      else stats.unknown += 1;
    }

    return stats;
  }

  private async reconcileAppGroup(
    appGroup: AppGroupCandidate,
    platformMaintenance: boolean,
  ) {
    const deployment = await this.prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId: appGroup.id,
        version: appGroup.currentDeploymentVersion ?? undefined,
        status: DeploymentStatus.Succeeded,
      },
      select: { stackConfig: true },
    });

    if (!deployment?.stackConfig) {
      await this.setUnknown(appGroup.id);
      return "Unknown" as const;
    }

    let snapshot: DriftSnapshot;
    try {
      snapshot = JSON.parse(deployment.stackConfig) as DriftSnapshot;
    } catch {
      await this.setUnknown(appGroup.id);
      return "Unknown" as const;
    }

    if (!Array.isArray(snapshot.singleApps)) {
      await this.setUnknown(appGroup.id);
      return "Unknown" as const;
    }

    const mapped = mapAppGroup(
      { ...appGroup, singleApps: undefined } as never,
      { platformMaintenance },
    );
    const appGroupBlocked = mapped.runtimeBlockers.length > 0;
    const currentRuntimeById = new Map(
      appGroup.singleApps.map((singleApp) => [
        singleApp.id,
        singleApp.runtimeState,
      ]),
    );
    const stackName = this.stackName(appGroup.id);
    const expected: ExpectedRuntimeService[] = snapshot.singleApps.map(
      (singleApp) => ({
        name: `${stackName}_${this.serviceName(singleApp.name)}`,
        image: singleApp.image,
        desiredReplicas:
          appGroupBlocked ||
          currentRuntimeById.get(singleApp.id) === RuntimeState.Stopped
            ? 0
            : singleApp.desiredReplicas,
      }),
    );
    const observed = await this.stackRuntime.inspectStackServices(stackName);
    if (observed === null) {
      // Preserve the last successful observation and timestamp so the API/UI can
      // distinguish stale data from a fresh observation of zero replicas.
      await this.setUnknown(appGroup.id);
      return "Unknown" as const;
    }

    const driftStatus = deriveAppGroupDriftStatus(expected, observed);
    if (driftStatus === "Unknown") {
      await this.setUnknown(appGroup.id);
      return driftStatus;
    }
    await this.persistObservation(
      appGroup.id,
      snapshot,
      expected,
      observed,
      driftStatus,
      new Date(),
    );
    return driftStatus;
  }

  private async persistObservation(
    appGroupId: string,
    snapshot: DriftSnapshot,
    expected: ExpectedRuntimeService[],
    observed: ObservedRuntimeService[],
    driftStatus: "InSync" | "Drifted",
    observedAt: Date,
  ) {
    const observedByName = new Map(
      observed.map((service) => [service.name, service]),
    );
    const expectedByName = new Map(
      expected.map((service) => [service.name, service]),
    );
    const stackName = this.stackName(appGroupId);
    const healthStates: HealthState[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const singleApp of snapshot.singleApps) {
        const serviceName = `${stackName}_${this.serviceName(singleApp.name)}`;
        const service = observedByName.get(serviceName);
        const expectedService = expectedByName.get(serviceName);
        const health = this.runtimeHealth(
          expectedService?.desiredReplicas ?? 0,
          service?.runningReplicas ?? 0,
          Boolean(service),
        );
        healthStates.push(health);

        await tx.singleApp.updateMany({
          where: { id: singleApp.id, appGroupId },
          data: {
            actualReplicas: service?.runningReplicas ?? 0,
            observedDesiredReplicas: service?.desiredReplicas ?? null,
            observedImage: service?.image ?? null,
            observedAt,
            health,
          },
        });
      }

      await tx.appGroup.update({
        where: { id: appGroupId },
        data: {
          driftStatus,
          health: this.aggregateHealth(healthStates),
          lastObservedAt: observedAt,
        },
      });
    });
  }

  private runtimeHealth(
    expectedReplicas: number,
    runningReplicas: number,
    serviceExists: boolean,
  ): HealthState {
    if (!serviceExists) {
      return expectedReplicas === 0 ? HealthState.Healthy : HealthState.Unhealthy;
    }
    if (expectedReplicas === 0) {
      return runningReplicas === 0 ? HealthState.Healthy : HealthState.Unhealthy;
    }
    if (runningReplicas === expectedReplicas) return HealthState.Healthy;
    if (runningReplicas === 0) return HealthState.Unhealthy;
    return HealthState.Degraded;
  }

  private aggregateHealth(states: HealthState[]): HealthState {
    if (states.some((state) => state === HealthState.Unhealthy)) {
      return HealthState.Unhealthy;
    }
    if (states.some((state) => state === HealthState.Degraded)) {
      return HealthState.Degraded;
    }
    return HealthState.Healthy;
  }

  private setUnknown(appGroupId: string) {
    return this.prisma.appGroup.update({
      where: { id: appGroupId },
      data: { driftStatus: "Unknown" },
    });
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }
}
