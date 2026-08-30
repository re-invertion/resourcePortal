import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AttachmentMode,
  DeploymentStatus,
  Prisma,
  RuntimeState,
} from "@prisma/client";
import crypto from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { VolumesService } from "../volumes/volumes.service";
import { AppGroupsService } from "./app-groups.service";
import { mapAppGroup } from "./app-groups.view";
import { buildDiscardRestorePlan } from "./discard-restore";

type RestorableStackConfigSnapshot = {
  appGroup: {
    runtimeState: RuntimeState;
  };
  singleApps: Array<{
    id: string;
    name: string;
    image: string;
    registryId: string | null;
    desiredReplicas: number;
    runtimeState: RuntimeState;
    resources: {
      cpu: string;
      memoryBytes: string;
      gpu: number;
    };
    environment: Prisma.InputJsonObject;
    variables?: Array<{
      id: string;
      variableId: string;
      variableName: string;
      targetName: string;
      value: string;
    }>;
    secrets?: Array<{
      id: string;
      attachmentId?: string;
      sourceType?: "AppGroup" | "LegacySingleApp";
      targetName?: string;
      name?: string;
      valueVersion: number;
    }>;
    configs?: Array<{
      id: string;
      configId: string;
      configName: string;
      contentVersion: number;
      targetPath: string;
      content: string;
    }>;
    healthCheck: Prisma.InputJsonValue | null;
    entrypoint: string | null;
    command: string[];
    workingDir: string | null;
    user: string | null;
    readOnlyRootFilesystem: boolean;
    stopGracePeriodSeconds: number;
    restartPolicy: Prisma.InputJsonValue;
    updatePolicy: Prisma.InputJsonValue;
    httpEndpoints?: Array<{
      id: string;
      name: string;
      containerPort: number;
      protocolMode: string;
      domains?: Array<{ id: string }>;
    }>;
    volumes?: Array<{
      id: string;
      volumeId: string;
      mountPath: string;
      mode: "ReadOnly" | "ReadWrite";
    }>;
  }>;
};

@Injectable()
export class Stage3AppGroupsService extends AppGroupsService {
  constructor(
    private readonly stage3Prisma: PrismaService,
    registriesService: RegistriesService,
    encryption: EncryptionService,
    secretStorage: SecretStorageService,
    stackRuntime: StackRuntimeService,
    volumesService: VolumesService,
    private readonly config: ConfigService,
  ) {
    super(
      stage3Prisma,
      registriesService,
      encryption,
      secretStorage,
      stackRuntime,
      volumesService,
    );
  }

  async listAppGroups(tenantId: string) {
    const appGroups = await this.stage3Prisma.appGroup.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        tenant: {
          select: {
            status: true,
            billing: { select: { balance: true } },
          },
        },
        singleApps: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    return appGroups.map((appGroup) =>
      mapAppGroup(appGroup, this.runtimeContext()),
    );
  }

  async getAppGroup(tenantId: string, appGroupId: string) {
    const appGroup = await this.stage3Prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      include: {
        tenant: {
          select: {
            status: true,
            billing: { select: { balance: true } },
          },
        },
        singleApps: {
          orderBy: { createdAt: "asc" },
        },
        deployments: {
          orderBy: { version: "desc" },
          take: 5,
        },
      },
    });

    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }

    return mapAppGroup(appGroup, this.runtimeContext());
  }

  async startAppGroup(
    tenantId: string,
    appGroupId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return super.startAppGroup(tenantId, appGroupId, actor);
  }

  async restartAppGroup(
    tenantId: string,
    appGroupId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return super.restartAppGroup(tenantId, appGroupId, actor);
  }

  async startSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return super.startSingleApp(tenantId, appGroupId, singleAppId, actor);
  }

  async restartSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return super.restartSingleApp(tenantId, appGroupId, singleAppId, actor);
  }

  async discardDraftChanges(
    tenantId: string,
    appGroupId: string,
    actor: AuthenticatedUser,
  ) {
    const appGroup = await this.stage3Prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
    });

    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }

    if (!appGroup.hasPendingChanges) {
      return this.getAppGroup(tenantId, appGroupId);
    }

    const deployedSnapshot = await this.findCurrentDeploymentSnapshot(
      appGroup.id,
      appGroup.currentDeploymentVersion,
    );
    const restorePlan = buildDiscardRestorePlan(deployedSnapshot);
    const snapshotAppIds = deployedSnapshot.singleApps.map(
      (singleApp) => singleApp.id,
    );

    await this.stage3Prisma.$transaction(async (tx) => {
      await this.assertNoActiveDeployment(tx, appGroupId);

      await tx.singleApp.deleteMany({
        where: {
          appGroupId,
          id: { notIn: snapshotAppIds },
        },
      });

      for (const singleApp of deployedSnapshot.singleApps) {
        await tx.singleApp.update({
          where: { id: singleApp.id },
          data: {
            name: singleApp.name,
            image: singleApp.image,
            registryId: singleApp.registryId,
            desiredReplicas: singleApp.desiredReplicas,
            runtimeState: singleApp.runtimeState,
            cpu: singleApp.resources.cpu,
            memoryBytes: BigInt(singleApp.resources.memoryBytes),
            gpu: singleApp.resources.gpu,
            environment: singleApp.environment,
            healthCheck:
              singleApp.healthCheck === null
                ? Prisma.JsonNull
                : singleApp.healthCheck,
            entrypoint: singleApp.entrypoint,
            command: singleApp.command,
            workingDir: singleApp.workingDir,
            user: singleApp.user,
            readOnlyRootFilesystem: singleApp.readOnlyRootFilesystem,
            stopGracePeriodSeconds: singleApp.stopGracePeriodSeconds,
            restartPolicy: singleApp.restartPolicy,
            updatePolicy: singleApp.updatePolicy,
            pendingDeletion: false,
            updatedBy: actor.id,
          },
        });
      }

      await Promise.all([
        tx.variableAttachment.deleteMany({
          where: { singleApp: { appGroupId } },
        }),
        tx.configAttachment.deleteMany({
          where: { singleApp: { appGroupId } },
        }),
        tx.volumeAttachment.deleteMany({
          where: { singleApp: { appGroupId } },
        }),
        tx.secretAttachment.deleteMany({
          where: { singleApp: { appGroupId } },
        }),
      ]);

      await this.restoreVariables(tx, appGroupId, actor, restorePlan);
      await this.restoreConfigs(tx, appGroupId, actor, restorePlan);
      await this.restoreVolumes(tx, tenantId, restorePlan);
      await this.restoreHttpEndpoints(tx, tenantId, appGroupId, restorePlan);
      await this.restoreSecretAttachments(tx, actor, deployedSnapshot);

      const secretVersionDrift = await this.hasSecretVersionDrift(
        tx,
        deployedSnapshot,
      );

      await tx.appGroup.update({
        where: { id: appGroupId },
        data: {
          runtimeState: deployedSnapshot.appGroup.runtimeState,
          hasPendingChanges: secretVersionDrift,
          runtimeDraftRevision: { increment: 1 },
          updatedBy: actor.id,
        },
      });

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "appgroup.discard_changes",
          resourceType: "AppGroup",
          resourceId: appGroupId,
          resourceName: appGroup.name,
          result: "Success",
          correlationId: crypto.randomUUID(),
          changes: {
            restoredDeploymentVersion: appGroup.currentDeploymentVersion,
            secretVersionDrift,
            restoredVariableAttachments: restorePlan.variableAttachments.length,
            restoredConfigAttachments: restorePlan.configAttachments.length,
            restoredVolumeAttachments: restorePlan.volumeAttachments.length,
            restoredHttpEndpoints: restorePlan.httpEndpoints.length,
            restoredDomainAssignments: restorePlan.domainAssignments.length,
          },
        },
      });
    });

    return this.getAppGroup(tenantId, appGroupId);
  }

  private runtimeContext() {
    return { platformMaintenance: this.platformMaintenanceEnabled() };
  }

  private platformMaintenanceEnabled() {
    return ["1", "true", "yes", "on"].includes(
      (this.config.get<string>("PLATFORM_MAINTENANCE_MODE") ?? "").toLowerCase(),
    );
  }

  private async assertExternalRuntimeUnblocked(
    tenantId: string,
    appGroupId: string,
  ) {
    const appGroup = await this.stage3Prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      include: {
        tenant: {
          select: {
            status: true,
            billing: { select: { balance: true } },
          },
        },
      },
    });

    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }

    const externalBlockers = mapAppGroup(
      appGroup,
      this.runtimeContext(),
    ).runtimeBlockers.filter((blocker) =>
      [
        "AppGroupDeleting",
        "AppGroupError",
        "TenantSuspended",
        "BillingSuspended",
        "PlatformMaintenance",
      ].includes(blocker),
    );

    if (externalBlockers.length > 0) {
      throw new ConflictException({
        code: "RuntimeBlocked",
        blockers: externalBlockers,
      });
    }
  }

  private async findCurrentDeploymentSnapshot(
    appGroupId: string,
    currentDeploymentVersion: number | null,
  ) {
    if (currentDeploymentVersion === null) {
      throw new ConflictException("AppGroup has no deployed state to restore");
    }

    const deployment = await this.stage3Prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        version: currentDeploymentVersion,
        status: DeploymentStatus.Succeeded,
      },
      select: { stackConfig: true },
    });

    if (!deployment?.stackConfig) {
      throw new ConflictException("Current deployment has no stack config");
    }

    return JSON.parse(deployment.stackConfig) as RestorableStackConfigSnapshot;
  }

  private async assertNoActiveDeployment(
    tx: Prisma.TransactionClient,
    appGroupId: string,
  ) {
    const activeDeployment = await tx.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        status: { in: ["Pending", "Deploying", "RollingBack"] },
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

  private async restoreVariables(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actor: AuthenticatedUser,
    restorePlan: ReturnType<typeof buildDiscardRestorePlan>,
  ) {
    const ids = restorePlan.variables.map((variable) => variable.id);
    const names = restorePlan.variables.map((variable) => variable.name);

    if (ids.length > 0) {
      await tx.variable.deleteMany({
        where: {
          appGroupId,
          id: { notIn: ids },
          name: { in: names },
        },
      });
    }

    for (const variable of restorePlan.variables) {
      await tx.variable.upsert({
        where: { id: variable.id },
        create: {
          id: variable.id,
          appGroupId,
          name: variable.name,
          value: variable.value,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        update: {
          name: variable.name,
          value: variable.value,
          updatedBy: actor.id,
        },
      });
    }

    if (restorePlan.variableAttachments.length > 0) {
      await tx.variableAttachment.createMany({
        data: restorePlan.variableAttachments.map((attachment) => ({
          ...attachment,
          createdBy: actor.id,
        })),
      });
    }
  }

  private async restoreConfigs(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actor: AuthenticatedUser,
    restorePlan: ReturnType<typeof buildDiscardRestorePlan>,
  ) {
    const ids = restorePlan.configs.map((config) => config.id);
    const names = restorePlan.configs.map((config) => config.name);

    if (ids.length > 0) {
      await tx.config.deleteMany({
        where: {
          appGroupId,
          id: { notIn: ids },
          name: { in: names },
        },
      });
    }

    for (const config of restorePlan.configs) {
      await tx.config.upsert({
        where: { id: config.id },
        create: {
          id: config.id,
          appGroupId,
          name: config.name,
          content: config.content,
          contentVersion: config.contentVersion,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        update: {
          name: config.name,
          content: config.content,
          contentVersion: config.contentVersion,
          updatedBy: actor.id,
        },
      });
    }

    if (restorePlan.configAttachments.length > 0) {
      await tx.configAttachment.createMany({
        data: restorePlan.configAttachments.map((attachment) => ({
          ...attachment,
          createdBy: actor.id,
        })),
      });
    }
  }

  private async restoreVolumes(
    tx: Prisma.TransactionClient,
    tenantId: string,
    restorePlan: ReturnType<typeof buildDiscardRestorePlan>,
  ) {
    const volumeIds = Array.from(
      new Set(
        restorePlan.volumeAttachments.map((attachment) => attachment.volumeId),
      ),
    );

    if (volumeIds.length > 0) {
      const available = await tx.volume.count({
        where: { id: { in: volumeIds }, tenantId },
      });

      if (available !== volumeIds.length) {
        throw new ConflictException("Discard snapshot references a missing Volume");
      }

      await tx.volumeAttachment.createMany({
        data: restorePlan.volumeAttachments.map((attachment) => ({
          ...attachment,
          mode: attachment.mode as AttachmentMode,
          createdBy: attachment.singleAppId,
        })),
      });
    }
  }

  private async restoreHttpEndpoints(
    tx: Prisma.TransactionClient,
    tenantId: string,
    appGroupId: string,
    restorePlan: ReturnType<typeof buildDiscardRestorePlan>,
  ) {
    const currentEndpoints = await tx.httpEndpoint.findMany({
      where: { singleApp: { appGroupId } },
      select: { id: true },
    });
    const currentEndpointIds = currentEndpoints.map((endpoint) => endpoint.id);

    if (currentEndpointIds.length > 0) {
      await tx.domain.updateMany({
        where: { httpEndpointId: { in: currentEndpointIds } },
        data: { httpEndpointId: null },
      });
    }

    await tx.httpEndpoint.deleteMany({
      where: { singleApp: { appGroupId } },
    });

    if (restorePlan.httpEndpoints.length > 0) {
      await tx.httpEndpoint.createMany({ data: restorePlan.httpEndpoints });
    }

    const domainIds = Array.from(
      new Set(restorePlan.domainAssignments.map((assignment) => assignment.domainId)),
    );

    if (domainIds.length === 0) {
      return;
    }

    const availableDomains = await tx.domain.count({
      where: { id: { in: domainIds }, tenantId },
    });

    if (availableDomains !== domainIds.length) {
      throw new ConflictException("Discard snapshot references a missing Domain");
    }

    for (const assignment of restorePlan.domainAssignments) {
      await tx.domain.update({
        where: { id: assignment.domainId },
        data: { httpEndpointId: assignment.httpEndpointId },
      });
    }
  }

  private async restoreSecretAttachments(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    snapshot: RestorableStackConfigSnapshot,
  ) {
    const attachments = snapshot.singleApps.flatMap((singleApp) =>
      (singleApp.secrets ?? [])
        .filter(
          (secret) =>
            secret.sourceType === "AppGroup" &&
            typeof secret.attachmentId === "string",
        )
        .map((secret) => ({
          id: secret.attachmentId as string,
          secretId: secret.id,
          singleAppId: singleApp.id,
          targetName: secret.targetName ?? secret.name ?? "secret",
          createdBy: actor.id,
        })),
    );

    if (attachments.length > 0) {
      await tx.secretAttachment.createMany({ data: attachments });
    }
  }

  private async hasSecretVersionDrift(
    tx: Prisma.TransactionClient,
    snapshot: RestorableStackConfigSnapshot,
  ) {
    const snapshotSecrets = snapshot.singleApps.flatMap(
      (singleApp) => singleApp.secrets ?? [],
    );
    const appGroupSecrets = snapshotSecrets.filter(
      (secret) => secret.sourceType === "AppGroup",
    );
    const legacySecrets = snapshotSecrets.filter(
      (secret) => secret.sourceType !== "AppGroup",
    );
    const [currentAppGroupSecrets, currentLegacySecrets] = await Promise.all([
      tx.secret.findMany({
        where: { id: { in: appGroupSecrets.map((secret) => secret.id) } },
        select: { id: true, valueVersion: true },
      }),
      tx.singleAppSecret.findMany({
        where: { id: { in: legacySecrets.map((secret) => secret.id) } },
        select: { id: true, valueVersion: true },
      }),
    ]);
    const currentVersions = new Map(
      [...currentAppGroupSecrets, ...currentLegacySecrets].map((secret) => [
        secret.id,
        secret.valueVersion,
      ]),
    );

    return snapshotSecrets.some(
      (secret) => currentVersions.get(secret.id) !== secret.valueVersion,
    );
  }
}
