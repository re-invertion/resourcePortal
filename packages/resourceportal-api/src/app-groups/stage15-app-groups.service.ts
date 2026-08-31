import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeploymentStatus,
  Prisma,
  RuntimeState,
} from "@prisma/client";
import {
  insufficientCapacityException,
  platformUnavailableException,
} from "../capacity/capacity-errors";
import {
  CapacityPreflightService,
  type CapacityAdmissionResult,
} from "../capacity/capacity-preflight.service";
import { AuthenticatedUser } from "../auth/types";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { VolumesService } from "../volumes/volumes.service";
import { mapAppGroup, mapSingleApp } from "./app-groups.view";
import { Stage11AppGroupsService } from "./stage11-app-groups.service";

type RuntimeScaleTarget = {
  stackName: string;
  serviceName: string;
  singleAppId: string;
  replicas: number;
};

const EXTERNAL_RUNTIME_BLOCKERS = new Set([
  "AppGroupDeleting",
  "AppGroupError",
  "TenantSuspended",
  "BillingSuspended",
  "PlatformMaintenance",
]);

@Injectable()
export class Stage15AppGroupsService extends Stage11AppGroupsService {
  constructor(
    private readonly stage15Prisma: PrismaService,
    registriesService: RegistriesService,
    encryption: EncryptionService,
    secretStorage: SecretStorageService,
    private readonly stage15StackRuntime: StackRuntimeService,
    volumesService: VolumesService,
    config: ConfigService,
    private readonly capacityPreflight: CapacityPreflightService,
  ) {
    super(
      stage15Prisma,
      registriesService,
      encryption,
      secretStorage,
      stage15StackRuntime,
      volumesService,
      config,
    );
  }

  async startAppGroup(
    tenantId: string,
    appGroupId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertStage15ExternalRuntimeUnblocked(tenantId, appGroupId);
    const { appGroup, targets } = await this.stage15Prisma.$transaction(
      async (tx) => {
        const current = await tx.appGroup.findFirst({
          where: { id: appGroupId, tenantId },
          include: {
            singleApps: {
              orderBy: { createdAt: "asc" },
            },
          },
        });

        if (!current) {
          throw new NotFoundException("App Group not found");
        }

        await this.assertStage15NoActiveDeployment(tx, appGroupId);
        this.assertStage15CapacityAdmission(
          await this.capacityPreflight.admitRuntimeStart(tx, { appGroupId }),
        );

        const serviceNames = await this.stage15DeployedServiceNames(tx, current);
        const targets = current.singleApps.flatMap((singleApp) => {
          const deployedServiceName = serviceNames.get(singleApp.id);
          if (!deployedServiceName) {
            return [];
          }

          return [
            {
              stackName: this.stage15StackName(appGroupId),
              serviceName: this.stage15ServiceName(deployedServiceName),
              singleAppId: singleApp.id,
              replicas:
                singleApp.runtimeState === RuntimeState.Stopped ||
                singleApp.pendingDeletion
                  ? 0
                  : singleApp.desiredReplicas,
            },
          ];
        });
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true },
        });
        const updated = await tx.appGroup.update({
          where: { id: appGroupId },
          data: {
            runtimeState: RuntimeState.Running,
            updatedBy: actor.id,
          },
          include: {
            singleApps: {
              orderBy: { createdAt: "asc" },
            },
          },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "appgroup.runtime.started",
            resourceType: "AppGroup",
            resourceId: appGroupId,
            resourceName: current.name,
            result: "Success",
            changes: {
              previousRuntimeState: current.runtimeState,
              runtimeState: RuntimeState.Running,
              runtimeApplied: targets.length > 0,
            },
          },
        });

        return { appGroup: updated, targets };
      },
    );

    await this.applyStage15ScaleTargets(targets);
    return {
      appGroup: mapAppGroup(appGroup),
      runtimeApplied: targets.length > 0,
    };
  }

  async startSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertStage15ExternalRuntimeUnblocked(tenantId, appGroupId);
    const { singleApp, targets } = await this.stage15Prisma.$transaction(
      async (tx) => {
        const appGroup = await tx.appGroup.findFirst({
          where: { id: appGroupId, tenantId },
          include: {
            singleApps: {
              orderBy: { createdAt: "asc" },
            },
          },
        });

        if (!appGroup) {
          throw new NotFoundException("App Group not found");
        }

        const existing = appGroup.singleApps.find(
          (singleApp) => singleApp.id === singleAppId,
        );
        if (!existing) {
          throw new NotFoundException("SingleApp not found");
        }
        if (existing.pendingDeletion) {
          throw new ConflictException("SingleApp is pending deletion");
        }

        await this.assertStage15NoActiveDeployment(tx, appGroupId);
        this.assertStage15CapacityAdmission(
          await this.capacityPreflight.admitRuntimeStart(tx, {
            appGroupId,
            singleAppId,
          }),
        );

        const serviceNames = await this.stage15DeployedServiceNames(tx, appGroup);
        const deployedServiceName = serviceNames.get(singleAppId);
        const targets: RuntimeScaleTarget[] = deployedServiceName
          ? [
              {
                stackName: this.stage15StackName(appGroupId),
                serviceName: this.stage15ServiceName(deployedServiceName),
                singleAppId,
                replicas:
                  appGroup.runtimeState === RuntimeState.Running
                    ? existing.desiredReplicas
                    : 0,
              },
            ]
          : [];
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true },
        });
        const updated = await tx.singleApp.update({
          where: { id: singleAppId },
          data: {
            runtimeState: RuntimeState.Running,
            updatedBy: actor.id,
          },
        });

        await tx.appGroup.update({
          where: { id: appGroupId },
          data: { updatedBy: actor.id },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "singleapp.runtime.started",
            resourceType: "SingleApp",
            resourceId: singleAppId,
            resourceName: existing.name,
            result: "Success",
            changes: {
              appGroupId,
              appGroupName: appGroup.name,
              previousRuntimeState: existing.runtimeState,
              runtimeState: RuntimeState.Running,
              runtimeApplied: targets.length > 0,
            },
          },
        });

        return { singleApp: updated, targets };
      },
    );

    await this.applyStage15ScaleTargets(targets);
    return {
      singleApp: mapSingleApp(singleApp),
      runtimeApplied: targets.length > 0,
    };
  }

  private async assertStage15ExternalRuntimeUnblocked(
    tenantId: string,
    appGroupId: string,
  ) {
    const appGroup = await this.getAppGroup(tenantId, appGroupId);
    const blockers = appGroup.runtimeBlockers.filter((blocker) =>
      EXTERNAL_RUNTIME_BLOCKERS.has(blocker),
    );
    if (blockers.length > 0) {
      throw new ConflictException({ code: "RuntimeBlocked", blockers });
    }
  }

  private assertStage15CapacityAdmission(result: CapacityAdmissionResult) {
    if (result.success) {
      return;
    }
    if (result.errorCode === "InsufficientCapacity") {
      throw insufficientCapacityException(result.message);
    }
    throw platformUnavailableException(result.message);
  }

  private async assertStage15NoActiveDeployment(
    tx: Prisma.TransactionClient,
    appGroupId: string,
  ) {
    const activeDeployment = await tx.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        status: {
          in: ["Pending", "Deploying", "RollingBack"],
        },
      },
      select: { status: true },
    });
    if (activeDeployment) {
      throw new ConflictException({
        code: "AppGroupBusy",
        message: `AppGroup has active deployment: ${activeDeployment.status}`,
      });
    }
  }

  private async stage15DeployedServiceNames(
    tx: Prisma.TransactionClient,
    appGroup: { id: string; currentDeploymentVersion: number | null },
  ) {
    if (appGroup.currentDeploymentVersion === null) {
      return new Map<string, string>();
    }
    const deployment = await tx.appGroupDeployment.findFirst({
      where: {
        appGroupId: appGroup.id,
        version: appGroup.currentDeploymentVersion,
        status: DeploymentStatus.Succeeded,
      },
      select: { stackConfig: true },
    });
    if (!deployment?.stackConfig) {
      return new Map<string, string>();
    }

    const parsed = JSON.parse(deployment.stackConfig) as {
      singleApps?: Array<{ id?: unknown; name?: unknown }>;
    };
    const names = new Map<string, string>();
    for (const singleApp of parsed.singleApps ?? []) {
      if (typeof singleApp.id === "string" && typeof singleApp.name === "string") {
        names.set(singleApp.id, singleApp.name);
      }
    }
    return names;
  }

  private async applyStage15ScaleTargets(targets: RuntimeScaleTarget[]) {
    if (targets.length === 0) {
      return;
    }
    const results = await this.stage15StackRuntime.scaleServices(targets);
    const failures = results.filter((result) => result.exitCode !== 0);
    if (failures.length > 0) {
      throw new ConflictException({
        code: "RuntimeOperationFailed",
        failures: failures.map((failure) => ({
          command: failure.command,
          exitCode: failure.exitCode,
          stderr: this.stage15Truncate(failure.stderr, 500),
        })),
      });
    }

    await this.stage15Prisma.$transaction(
      targets.map((target) =>
        this.stage15Prisma.singleApp.update({
          where: { id: target.singleAppId },
          data: { actualReplicas: target.replicas },
        }),
      ),
    );
  }

  private stage15StackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private stage15ServiceName(name: string) {
    return name.replaceAll("-", "_");
  }

  private stage15Truncate(value: string, maxLength: number) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}