import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DeploymentStatus, RuntimeState } from "@prisma/client";
import {
  deriveAppGroupDriftStatus,
  ExpectedRuntimeService,
} from "../app-groups/runtime-drift";
import { mapAppGroup } from "../app-groups/app-groups.view";
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

@Injectable()
export class RuntimeDriftReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stackRuntime: StackRuntimeService,
    private readonly config: ConfigService,
  ) {}

  async reconcileBatch(limit = 50) {
    const appGroups = await this.prisma.appGroup.findMany({
      where: { currentDeploymentVersion: { not: null } },
      orderBy: { updatedAt: "asc" },
      take: limit,
      include: {
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
      },
    });

    let inSync = 0;
    let drifted = 0;
    let unknown = 0;

    for (const appGroup of appGroups) {
      const driftStatus = await this.reconcileAppGroup(appGroup);

      if (driftStatus === "InSync") {
        inSync += 1;
      } else if (driftStatus === "Drifted") {
        drifted += 1;
      } else {
        unknown += 1;
      }
    }

    return {
      scanned: appGroups.length,
      inSync,
      drifted,
      unknown,
    };
  }

  private async reconcileAppGroup(appGroup: {
    id: string;
    status: string;
    runtimeState: RuntimeState;
    currentDeploymentVersion: number | null;
    tenant: {
      status: string;
      billing: { balance: { lte(value: number): boolean } } | null;
    };
    singleApps: Array<{ id: string; runtimeState: RuntimeState }>;
  }) {
    const deployment = await this.prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId: appGroup.id,
        version: appGroup.currentDeploymentVersion ?? undefined,
        status: DeploymentStatus.Succeeded,
      },
      select: { stackConfig: true },
    });

    if (!deployment?.stackConfig) {
      await this.setDriftStatus(appGroup.id, "Unknown");
      return "Unknown" as const;
    }

    let snapshot: DriftSnapshot;

    try {
      snapshot = JSON.parse(deployment.stackConfig) as DriftSnapshot;
    } catch {
      await this.setDriftStatus(appGroup.id, "Unknown");
      return "Unknown" as const;
    }

    if (!Array.isArray(snapshot.singleApps)) {
      await this.setDriftStatus(appGroup.id, "Unknown");
      return "Unknown" as const;
    }

    const mapped = mapAppGroup(
      { ...appGroup, singleApps: undefined } as never,
      { platformMaintenance: this.platformMaintenanceEnabled() },
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
    const driftStatus = deriveAppGroupDriftStatus(expected, observed);

    await this.setDriftStatus(appGroup.id, driftStatus);
    return driftStatus;
  }

  private setDriftStatus(
    appGroupId: string,
    driftStatus: "InSync" | "Drifted" | "Unknown",
  ) {
    return this.prisma.appGroup.update({
      where: { id: appGroupId },
      data: { driftStatus },
    });
  }

  private platformMaintenanceEnabled() {
    return ["1", "true", "yes", "on"].includes(
      (this.config.get<string>("PLATFORM_MAINTENANCE_MODE") ?? "").toLowerCase(),
    );
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }
}
