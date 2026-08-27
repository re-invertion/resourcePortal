import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AppGroup,
  Config,
  ConfigAttachment,
  Domain,
  HttpEndpoint,
  Prisma,
  RuntimeState,
  SingleAppSecret,
  Variable,
  VariableAttachment,
  Volume,
  VolumeAttachment,
} from "@prisma/client";
import crypto from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { VolumesService } from "../volumes/volumes.service";
import { AttachConfigDto } from "./dto/attach-config.dto";
import { AttachVariableDto } from "./dto/attach-variable.dto";
import { AttachVolumeDto } from "./dto/attach-volume.dto";
import { CreateAppGroupDto } from "./dto/create-app-group.dto";
import { CreateConfigDto } from "./dto/create-config.dto";
import { CreateHttpEndpointDto } from "./dto/create-http-endpoint.dto";
import { CreateSingleAppDto } from "./dto/create-single-app.dto";
import { CreateVariableDto } from "./dto/create-variable.dto";
import { DeployAppGroupDto } from "./dto/deploy-app-group.dto";
import { RollbackDeploymentDto } from "./dto/rollback-deployment.dto";
import { UpdateConfigDto } from "./dto/update-config.dto";
import { UpdateHttpEndpointDto } from "./dto/update-http-endpoint.dto";
import {
  RUNTIME_CONFIG_NAME_PATTERN,
  UpdateRuntimeConfigDto,
} from "./dto/update-runtime-config.dto";
import { UpdateSingleAppDto } from "./dto/update-single-app.dto";
import { UpdateVariableDto } from "./dto/update-variable.dto";
import {
  mapAppGroup,
  mapAppGroupDeployment,
  mapConfig,
  mapConfigAttachment,
  mapDeploymentEvent,
  mapSingleApp,
  mapVariable,
  mapVariableAttachment,
} from "./app-groups.view";

const DEFAULT_RESTART_POLICY = {
  condition: "on-failure",
  delaySeconds: 5,
  maxAttempts: 3,
  windowSeconds: 60,
} satisfies Prisma.InputJsonObject;

const DEFAULT_UPDATE_POLICY = {
  parallelism: 1,
  delaySeconds: 10,
  order: "start-first",
} satisfies Prisma.InputJsonObject;

type DeployableDraft = AppGroup & {
  singleApps: Array<{
    id: string;
    appGroupId: string;
    name: string;
    description: string | null;
    image: string;
    registryId: string | null;
    desiredReplicas: number;
    pendingDeletion: boolean;
    runtimeState: RuntimeState;
    actualReplicas: number;
    health: string;
    cpu: Prisma.Decimal;
    memoryBytes: bigint;
    gpu: number;
    environment: Prisma.JsonValue;
    healthCheck: Prisma.JsonValue;
    entrypoint: string | null;
    command: string[];
    workingDir: string | null;
    user: string | null;
    readOnlyRootFilesystem: boolean;
    stopGracePeriodSeconds: number;
    restartPolicy: Prisma.JsonValue;
    updatePolicy: Prisma.JsonValue;
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;
    httpEndpoints: Array<HttpEndpoint & { domains: Domain[] }>;
    volumeAttachments: Array<VolumeAttachment & { volume: Volume }>;
    variableAttachments: Array<VariableAttachment & { variable: Variable }>;
    configAttachments: Array<ConfigAttachment & { config: Config }>;
    secrets: SingleAppSecret[];
  }>;
};

@Injectable()
export class AppGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registriesService: RegistriesService,
    private readonly volumesService: VolumesService,
  ) {}

  async listAppGroups(tenantId: string) {
    const appGroups = await this.prisma.appGroup.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        singleApps: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    return appGroups.map(mapAppGroup);
  }

  async getAppGroup(tenantId: string, appGroupId: string) {
    const appGroup = await this.prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      include: {
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

    return mapAppGroup(appGroup);
  }

  async listDeployments(tenantId: string, appGroupId: string) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const deployments = await this.prisma.appGroupDeployment.findMany({
      where: { appGroupId },
      orderBy: { version: "desc" },
    });

    return deployments.map(mapAppGroupDeployment);
  }

  async getDeployment(
    tenantId: string,
    appGroupId: string,
    deploymentId: string,
  ) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const deployment = await this.prisma.appGroupDeployment.findFirst({
      where: { id: deploymentId, appGroupId },
    });

    if (!deployment) {
      throw new NotFoundException("Deployment not found");
    }

    return mapAppGroupDeployment(deployment);
  }

  async listDeploymentEvents(
    tenantId: string,
    appGroupId: string,
    deploymentId: string,
  ) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const deployment = await this.prisma.appGroupDeployment.findFirst({
      where: { id: deploymentId, appGroupId },
      select: { id: true },
    });

    if (!deployment) {
      throw new NotFoundException("Deployment not found");
    }

    const events = await this.prisma.deploymentEvent.findMany({
      where: { deploymentId },
      orderBy: { timestamp: "asc" },
    });

    return events.map(mapDeploymentEvent);
  }

  async deployAppGroup(
    tenantId: string,
    appGroupId: string,
    dto: DeployAppGroupDto,
    idempotencyKey: string | undefined,
    actor: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey =
      this.normalizeIdempotencyKey(idempotencyKey);
    const draft = await this.getDeployableDraft(tenantId, appGroupId);
    this.assertDraftCanBeDeployed(draft, dto.force ?? false);

    const stackConfig = this.buildStackConfigSnapshot(draft, dto.note);

    const deployment = await this.prisma.$transaction(async (tx) => {
      const existingDeployment = await this.findIdempotentDeployment(
        tx,
        appGroupId,
        normalizedIdempotencyKey,
      );

      if (existingDeployment) {
        return existingDeployment;
      }

      const activeDeployment = await this.findActiveDeployment(tx, appGroupId);

      if (activeDeployment) {
        throw new ConflictException(
          `AppGroup has active deployment: ${activeDeployment.status}`,
        );
      }

      const version = await this.nextDeploymentVersion(tx, appGroupId);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const correlationId = dto.correlationId ?? crypto.randomUUID();

      const created = await tx.appGroupDeployment.create({
        data: {
          appGroupId,
          version,
          status: "Pending",
          phase: "Validating",
          stackConfig: JSON.stringify(stackConfig),
          sourceDraftRevision: draft.runtimeDraftRevision,
          correlationId,
          idempotencyKey: normalizedIdempotencyKey,
          createdBy: actor.id,
          events: {
            create: {
              phase: "Validating",
              level: "Info",
              message: "Deployment accepted and queued for worker execution",
            },
          },
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "appgroup.deploy.started",
          resourceType: "AppGroup",
          resourceId: appGroupId,
          resourceName: draft.name,
          result: "Success",
          correlationId,
          changes: {
            deploymentId: created.id,
            version,
            sourceDraftRevision: draft.runtimeDraftRevision,
          },
        },
      });

      await tx.appGroup.update({
        where: { id: appGroupId },
        data: {
          lastDeploymentAt: new Date(),
          lastDeploymentBy: actor.id,
          updatedBy: actor.id,
        },
      });

      return created;
    });

    return mapAppGroupDeployment(deployment);
  }

  async rollbackDeployment(
    tenantId: string,
    appGroupId: string,
    deploymentId: string,
    dto: RollbackDeploymentDto,
    idempotencyKey: string | undefined,
    actor: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey =
      this.normalizeIdempotencyKey(idempotencyKey);
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const deployment = await this.prisma.$transaction(async (tx) => {
      const existingDeployment = await this.findIdempotentDeployment(
        tx,
        appGroupId,
        normalizedIdempotencyKey,
      );

      if (existingDeployment) {
        return existingDeployment;
      }

      const targetDeployment = await tx.appGroupDeployment.findFirst({
        where: { id: deploymentId, appGroupId },
      });

      if (!targetDeployment) {
        throw new NotFoundException("Deployment not found");
      }

      if (targetDeployment.status !== "Succeeded") {
        throw new ConflictException("Only succeeded deployments can be rolled back to");
      }

      if (!targetDeployment.stackConfig) {
        throw new ConflictException("Deployment has no stack config");
      }

      const activeDeployment = await this.findActiveDeployment(tx, appGroupId);

      if (activeDeployment) {
        throw new ConflictException(
          `AppGroup has active deployment: ${activeDeployment.status}`,
        );
      }

      const appGroup = await tx.appGroup.findUniqueOrThrow({
        where: { id: appGroupId },
        select: { name: true, runtimeDraftRevision: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const version = await this.nextDeploymentVersion(tx, appGroupId);
      const correlationId = dto.correlationId ?? crypto.randomUUID();
      const note = dto.note
        ? `Rollback to v${targetDeployment.version}: ${dto.note}`
        : `Rollback to v${targetDeployment.version}`;

      const created = await tx.appGroupDeployment.create({
        data: {
          appGroupId,
          version,
          status: "Pending",
          phase: "Validating",
          stackConfig: targetDeployment.stackConfig,
          sourceDraftRevision: appGroup.runtimeDraftRevision,
          rollbackTargetVersion: targetDeployment.version,
          correlationId,
          idempotencyKey: normalizedIdempotencyKey,
          createdBy: actor.id,
          events: {
            create: {
              phase: "Validating",
              level: "Info",
              message: `${note} accepted and queued for worker execution`,
            },
          },
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "appgroup.rollback.started",
          resourceType: "AppGroupDeployment",
          resourceId: targetDeployment.id,
          resourceName: `v${targetDeployment.version}`,
          result: "Success",
          correlationId,
          changes: {
            deploymentId: created.id,
            version,
            rollbackTargetVersion: targetDeployment.version,
            appGroupId,
            appGroupName: appGroup.name,
          },
        },
      });

      await tx.appGroup.update({
        where: { id: appGroupId },
        data: {
          lastDeploymentAt: new Date(),
          lastDeploymentBy: actor.id,
          updatedBy: actor.id,
        },
      });

      return created;
    });

    return mapAppGroupDeployment(deployment);
  }

  async listVariables(tenantId: string, appGroupId: string) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const variables = await this.prisma.variable.findMany({
      where: { appGroupId },
      include: { attachments: true },
      orderBy: { name: "asc" },
    });

    return variables.map(mapVariable);
  }

  async createVariable(
    tenantId: string,
    appGroupId: string,
    dto: CreateVariableDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    try {
      const variable = await this.prisma.variable.create({
        data: {
          appGroupId,
          name: dto.name,
          description: dto.description,
          value: dto.value,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { attachments: true },
      });

      return mapVariable(variable);
    } catch (error) {
      this.handleKnownConflict(error, "Variable name already exists");
      throw error;
    }
  }

  async updateVariable(
    tenantId: string,
    appGroupId: string,
    variableId: string,
    dto: UpdateVariableDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findVariableOrThrow(tenantId, appGroupId, variableId);
    const contentChanged = dto.value !== undefined && dto.value !== existing.value;

    try {
      const variable = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.variable.update({
          where: { id: variableId },
          data: {
            name: dto.name,
            description: dto.description,
            value: dto.value,
            updatedBy: actor.id,
          },
          include: { attachments: true },
        });

        if (contentChanged && existing.attachments.length > 0) {
          await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
        }

        return updated;
      });

      return mapVariable(variable);
    } catch (error) {
      this.handleKnownConflict(error, "Variable name already exists");
      throw error;
    }
  }

  async deleteVariable(tenantId: string, appGroupId: string, variableId: string) {
    const variable = await this.findVariableOrThrow(tenantId, appGroupId, variableId);

    if (variable.attachments.length > 0) {
      throw new ConflictException("VariableInUse");
    }

    await this.prisma.variable.delete({
      where: { id: variableId },
    });

    return { deleted: true };
  }

  async attachVariable(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: AttachVariableDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    await this.findVariableOrThrow(tenantId, appGroupId, dto.variableId);

    try {
      const attachment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.variableAttachment.create({
          data: {
            variableId: dto.variableId,
            singleAppId,
            targetName: dto.targetName,
            createdBy: actor.id,
          },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return created;
      });

      return mapVariableAttachment(attachment);
    } catch (error) {
      this.handleKnownConflict(
        error,
        "Variable already attached or target name already used",
      );
      throw error;
    }
  }

  async detachVariable(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    attachmentId: string,
    actor: AuthenticatedUser,
  ) {
    await this.ensureSingleAppBelongsToAppGroup(tenantId, appGroupId, singleAppId);

    const attachment = await this.prisma.variableAttachment.findFirst({
      where: {
        id: attachmentId,
        singleAppId,
        singleApp: {
          appGroup: {
            id: appGroupId,
            tenantId,
          },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundException("Variable attachment not found");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.variableAttachment.delete({
        where: { id: attachmentId },
      });

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
    });

    return { deleted: true };
  }

  async listConfigs(tenantId: string, appGroupId: string) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const configs = await this.prisma.config.findMany({
      where: { appGroupId },
      include: { attachments: true },
      orderBy: { name: "asc" },
    });

    return configs.map(mapConfig);
  }

  async createConfig(
    tenantId: string,
    appGroupId: string,
    dto: CreateConfigDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    try {
      const config = await this.prisma.config.create({
        data: {
          appGroupId,
          name: dto.name,
          description: dto.description,
          content: dto.content,
          contentVersion: 1,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { attachments: true },
      });

      return mapConfig(config);
    } catch (error) {
      this.handleKnownConflict(error, "Config name already exists");
      throw error;
    }
  }

  async updateConfig(
    tenantId: string,
    appGroupId: string,
    configId: string,
    dto: UpdateConfigDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findConfigOrThrow(tenantId, appGroupId, configId);
    const contentChanged =
      dto.content !== undefined && dto.content !== existing.content;

    try {
      const config = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.config.update({
          where: { id: configId },
          data: {
            name: dto.name,
            description: dto.description,
            content: dto.content,
            contentVersion: contentChanged
              ? { increment: 1 }
              : undefined,
            updatedBy: actor.id,
          },
          include: { attachments: true },
        });

        if (contentChanged && existing.attachments.length > 0) {
          await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
        }

        return updated;
      });

      return mapConfig(config);
    } catch (error) {
      this.handleKnownConflict(error, "Config name already exists");
      throw error;
    }
  }

  async deleteConfig(tenantId: string, appGroupId: string, configId: string) {
    const config = await this.findConfigOrThrow(tenantId, appGroupId, configId);

    if (config.attachments.length > 0) {
      throw new ConflictException("ConfigInUse");
    }

    await this.prisma.config.delete({
      where: { id: configId },
    });

    return { deleted: true };
  }

  async attachConfig(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: AttachConfigDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    this.assertSafeAbsoluteFilePath(dto.targetPath);
    await this.findConfigOrThrow(tenantId, appGroupId, dto.configId);

    try {
      const attachment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.configAttachment.create({
          data: {
            configId: dto.configId,
            singleAppId,
            targetPath: dto.targetPath,
            createdBy: actor.id,
          },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return created;
      });

      return mapConfigAttachment(attachment);
    } catch (error) {
      this.handleKnownConflict(
        error,
        "Config already attached or target path already used",
      );
      throw error;
    }
  }

  async detachConfig(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    attachmentId: string,
    actor: AuthenticatedUser,
  ) {
    await this.ensureSingleAppBelongsToAppGroup(tenantId, appGroupId, singleAppId);

    const attachment = await this.prisma.configAttachment.findFirst({
      where: {
        id: attachmentId,
        singleAppId,
        singleApp: {
          appGroup: {
            id: appGroupId,
            tenantId,
          },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundException("Config attachment not found");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.configAttachment.delete({
        where: { id: attachmentId },
      });

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
    });

    return { deleted: true };
  }

  async createAppGroup(
    tenantId: string,
    dto: CreateAppGroupDto,
    actor: AuthenticatedUser,
  ) {
    try {
      const appGroup = await this.prisma.appGroup.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          runtimeState: dto.runtimeState ?? RuntimeState.Stopped,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: {
          singleApps: true,
        },
      });

      return mapAppGroup(appGroup);
    } catch (error) {
      this.handleKnownConflict(error, "App Group name already exists");
      throw error;
    }
  }

  async listSingleApps(tenantId: string, appGroupId: string) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);

    const singleApps = await this.prisma.singleApp.findMany({
      where: { appGroupId },
      orderBy: { createdAt: "asc" },
    });

    return singleApps.map(mapSingleApp);
  }

  async createSingleApp(
    tenantId: string,
    appGroupId: string,
    dto: CreateSingleAppDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureAppGroupBelongsToTenant(tenantId, appGroupId);
    await this.assertQuotaAllowsSingleAppChange(tenantId, {
      cpu: dto.cpu,
      memoryBytes: dto.memoryBytes,
      gpu: dto.gpu ?? 0,
      desiredReplicas: dto.desiredReplicas ?? 1,
    });
    await this.registriesService.assertRegistryCanBeUsedByImage(
      tenantId,
      dto.registryId,
      dto.image,
    );

    try {
      const singleApp = await this.prisma.$transaction(async (tx) => {
        const created = await tx.singleApp.create({
          data: {
            appGroupId,
            name: dto.name,
            description: dto.description,
            image: dto.image,
            registryId: dto.registryId,
            desiredReplicas: dto.desiredReplicas ?? 1,
            runtimeState: dto.runtimeState ?? RuntimeState.Running,
            cpu: dto.cpu,
            memoryBytes: dto.memoryBytes,
            gpu: dto.gpu ?? 0,
            environment: this.toJsonObject(dto.environment) ?? {},
            healthCheck: this.toJsonObject(dto.healthCheck),
            entrypoint: dto.entrypoint,
            command: dto.command ?? [],
            workingDir: dto.workingDir,
            user: dto.user,
            readOnlyRootFilesystem: dto.readOnlyRootFilesystem ?? false,
            stopGracePeriodSeconds: dto.stopGracePeriodSeconds ?? 30,
            restartPolicy:
              this.toJsonObject(dto.restartPolicy) ?? DEFAULT_RESTART_POLICY,
            updatePolicy:
              this.toJsonObject(dto.updatePolicy) ?? DEFAULT_UPDATE_POLICY,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });

        await tx.appGroup.update({
          where: { id: appGroupId },
          data: {
            hasPendingChanges: true,
            runtimeDraftRevision: {
              increment: 1,
            },
            updatedBy: actor.id,
          },
        });

        return created;
      });

      return mapSingleApp(singleApp);
    } catch (error) {
      this.handleKnownConflict(error, "SingleApp name already exists");
      throw error;
    }
  }

  async updateSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: UpdateSingleAppDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (existing.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    const nextRuntimeShape = {
      cpu: dto.cpu ?? Number(existing.cpu),
      memoryBytes: dto.memoryBytes ?? Number(existing.memoryBytes),
      gpu: dto.gpu ?? existing.gpu,
      desiredReplicas: dto.desiredReplicas ?? existing.desiredReplicas,
    };
    const nextImage = dto.image ?? existing.image;
    const nextRegistryId =
      dto.registryId === undefined ? existing.registryId : dto.registryId;

    await this.assertQuotaAllowsSingleAppChange(
      tenantId,
      nextRuntimeShape,
      singleAppId,
    );
    await this.registriesService.assertRegistryCanBeUsedByImage(
      tenantId,
      nextRegistryId,
      nextImage,
    );

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const singleApp = await tx.singleApp.update({
          where: { id: singleAppId },
          data: {
            name: dto.name,
            description: dto.description,
            image: dto.image,
            registryId: dto.registryId,
            desiredReplicas: dto.desiredReplicas,
            runtimeState: dto.runtimeState,
            cpu: dto.cpu,
            memoryBytes: dto.memoryBytes,
            gpu: dto.gpu,
            environment: this.toJsonObject(dto.environment),
            healthCheck: this.toJsonObject(dto.healthCheck),
            entrypoint: dto.entrypoint,
            command: dto.command,
            workingDir: dto.workingDir,
            user: dto.user,
            readOnlyRootFilesystem: dto.readOnlyRootFilesystem,
            stopGracePeriodSeconds: dto.stopGracePeriodSeconds,
            restartPolicy: this.toJsonObject(dto.restartPolicy),
            updatePolicy: this.toJsonObject(dto.updatePolicy),
            updatedBy: actor.id,
          },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return singleApp;
      });

      return mapSingleApp(updated);
    } catch (error) {
      this.handleKnownConflict(error, "SingleApp name already exists");
      throw error;
    }
  }

  async markSingleAppPendingDeletion(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (existing.pendingDeletion) {
      return mapSingleApp(existing);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const singleApp = await tx.singleApp.update({
        where: { id: singleAppId },
        data: {
          pendingDeletion: true,
          updatedBy: actor.id,
        },
      });

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

      return singleApp;
    });

    return mapSingleApp(updated);
  }

  async getSingleAppRuntimeConfig(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    const secrets = await this.prisma.singleAppSecret.findMany({
      where: { singleAppId },
      orderBy: { name: "asc" },
    });

    return this.mapRuntimeConfig(singleApp.environment, secrets);
  }

  async listHttpEndpoints(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
  ) {
    await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    const endpoints = await this.prisma.httpEndpoint.findMany({
      where: { singleAppId },
      orderBy: { name: "asc" },
      include: { domains: true },
    });

    return endpoints.map((endpoint) => this.mapHttpEndpoint(endpoint));
  }

  async getHttpEndpoint(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    httpEndpointId: string,
  ) {
    const endpoint = await this.findHttpEndpointOrThrow(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
    );

    return this.mapHttpEndpoint(endpoint);
  }

  async createHttpEndpoint(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: CreateHttpEndpointDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    try {
      const endpoint = await this.prisma.$transaction(async (tx) => {
        const created = await tx.httpEndpoint.create({
          data: {
            singleAppId,
            name: dto.name,
            containerPort: dto.containerPort,
            protocolMode: dto.protocolMode ?? "HTTP_REDIRECT_TO_HTTPS",
          },
          include: { domains: true },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return created;
      });

      return this.mapHttpEndpoint(endpoint);
    } catch (error) {
      this.handleKnownConflict(error, "HTTP endpoint name already exists");
      throw error;
    }
  }

  async updateHttpEndpoint(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    httpEndpointId: string,
    dto: UpdateHttpEndpointDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    await this.findHttpEndpointOrThrow(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
    );

    try {
      const endpoint = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.httpEndpoint.update({
          where: { id: httpEndpointId },
          data: {
            name: dto.name,
            containerPort: dto.containerPort,
            protocolMode: dto.protocolMode,
          },
          include: { domains: true },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return updated;
      });

      return this.mapHttpEndpoint(endpoint);
    } catch (error) {
      this.handleKnownConflict(error, "HTTP endpoint name already exists");
      throw error;
    }
  }

  async deleteHttpEndpoint(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    httpEndpointId: string,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    const endpoint = await this.findHttpEndpointOrThrow(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
    );

    if (endpoint.domains.length > 0) {
      throw new ConflictException("HttpEndpointInUse");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.httpEndpoint.delete({
        where: { id: httpEndpointId },
      });

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
    });

    return { deleted: true };
  }

  async updateSingleAppRuntimeConfig(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: UpdateRuntimeConfigDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    const nextEnvironment =
      dto.environment === undefined
        ? undefined
        : this.mergeEnvironment(singleApp.environment, dto.environment);

    const updated = await this.prisma.$transaction(async (tx) => {
      const app =
        nextEnvironment === undefined
          ? singleApp
          : await tx.singleApp.update({
              where: { id: singleAppId },
              data: {
                environment: nextEnvironment,
                updatedBy: actor.id,
              },
            });

      for (const secret of dto.secrets ?? []) {
        await tx.singleAppSecret.upsert({
          where: {
            singleAppId_name: {
              singleAppId,
              name: secret.name,
            },
          },
          create: {
            singleAppId,
            name: secret.name,
            description: secret.description,
            valueCiphertext: secret.value,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          update: {
            description: secret.description,
            valueCiphertext: secret.value,
            valueVersion: {
              increment: 1,
            },
            updatedBy: actor.id,
          },
        });
      }

      if (dto.removeSecrets?.length) {
        await tx.singleAppSecret.deleteMany({
          where: {
            singleAppId,
            name: {
              in: dto.removeSecrets,
            },
          },
        });
      }

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

      const secrets = await tx.singleAppSecret.findMany({
        where: { singleAppId },
        orderBy: { name: "asc" },
      });

      return { app, secrets };
    });

    return this.mapRuntimeConfig(updated.app.environment, updated.secrets);
  }

  async attachVolume(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    dto: AttachVolumeDto,
    actor: AuthenticatedUser,
  ) {
    const singleApp = await this.ensureSingleAppBelongsToAppGroup(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (singleApp.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    await this.volumesService.assertVolumeBelongsToTenant(
      tenantId,
      dto.volumeId,
    );

    try {
      const attachment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.volumeAttachment.create({
          data: {
            volumeId: dto.volumeId,
            singleAppId,
            mountPath: dto.mountPath,
            mode: dto.mode,
            createdBy: actor.id,
          },
        });

        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);

        return created;
      });

      return this.mapVolumeAttachment(attachment);
    } catch (error) {
      this.handleKnownConflict(
        error,
        "Volume already attached or mount path already used",
      );
      throw error;
    }
  }

  async detachVolume(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    attachmentId: string,
    actor: AuthenticatedUser,
  ) {
    await this.ensureSingleAppBelongsToAppGroup(tenantId, appGroupId, singleAppId);

    const attachment = await this.prisma.volumeAttachment.findFirst({
      where: {
        id: attachmentId,
        singleAppId,
        singleApp: {
          appGroup: {
            id: appGroupId,
            tenantId,
          },
        },
      },
    });

    if (!attachment) {
      throw new NotFoundException("Volume attachment not found");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.volumeAttachment.delete({
        where: { id: attachmentId },
      });

      await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
    });

    return { deleted: true };
  }

  private async ensureAppGroupBelongsToTenant(
    tenantId: string,
    appGroupId: string,
  ) {
    const appGroup = await this.prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      select: { id: true },
    });

    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }
  }

  private async findActiveDeployment(
    tx: Prisma.TransactionClient,
    appGroupId: string,
  ) {
    return tx.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        status: {
          in: ["Pending", "Deploying", "RollingBack"],
        },
      },
      select: { id: true, status: true },
    });
  }

  private async findIdempotentDeployment(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey) {
      return null;
    }

    return tx.appGroupDeployment.findUnique({
      where: {
        appGroupId_idempotencyKey: {
          appGroupId,
          idempotencyKey,
        },
      },
    });
  }

  private normalizeIdempotencyKey(idempotencyKey: string | undefined) {
    const normalized = idempotencyKey?.trim();
    return normalized && normalized.length > 0 ? normalized.slice(0, 255) : undefined;
  }

  private async nextDeploymentVersion(
    tx: Prisma.TransactionClient,
    appGroupId: string,
  ) {
    const latest = await tx.appGroupDeployment.findFirst({
      where: { appGroupId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    return (latest?.version ?? 0) + 1;
  }

  private async findVariableOrThrow(
    tenantId: string,
    appGroupId: string,
    variableId: string,
  ) {
    const variable = await this.prisma.variable.findFirst({
      where: {
        id: variableId,
        appGroup: {
          id: appGroupId,
          tenantId,
        },
      },
      include: { attachments: true },
    });

    if (!variable) {
      throw new NotFoundException("Variable not found");
    }

    return variable;
  }

  private async findConfigOrThrow(
    tenantId: string,
    appGroupId: string,
    configId: string,
  ) {
    const config = await this.prisma.config.findFirst({
      where: {
        id: configId,
        appGroup: {
          id: appGroupId,
          tenantId,
        },
      },
      include: { attachments: true },
    });

    if (!config) {
      throw new NotFoundException("Config not found");
    }

    return config;
  }

  private assertSafeAbsoluteFilePath(path: string) {
    const parts = path.split("/").filter(Boolean);

    if (!path.startsWith("/") || path.endsWith("/") || parts.includes("..")) {
      throw new BadRequestException("Config targetPath must be an absolute file path");
    }
  }

  private async ensureSingleAppBelongsToAppGroup(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
  ) {
    const singleApp = await this.prisma.singleApp.findFirst({
      where: {
        id: singleAppId,
        appGroup: {
          id: appGroupId,
          tenantId,
        },
      },
    });

    if (!singleApp) {
      throw new NotFoundException("SingleApp not found");
    }

    return singleApp;
  }

  private async findHttpEndpointOrThrow(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    httpEndpointId: string,
  ) {
    const endpoint = await this.prisma.httpEndpoint.findFirst({
      where: {
        id: httpEndpointId,
        singleAppId,
        singleApp: {
          appGroup: {
            id: appGroupId,
            tenantId,
          },
        },
      },
      include: { domains: true },
    });

    if (!endpoint) {
      throw new NotFoundException("HTTP endpoint not found");
    }

    return endpoint;
  }

  private async getDeployableDraft(tenantId: string, appGroupId: string) {
    const appGroup = await this.prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      include: {
        singleApps: {
          orderBy: { createdAt: "asc" },
          include: {
            httpEndpoints: {
              orderBy: { name: "asc" },
              include: { domains: { orderBy: { hostname: "asc" } } },
            },
            volumeAttachments: {
              orderBy: { mountPath: "asc" },
              include: { volume: true },
            },
            variableAttachments: {
              orderBy: { targetName: "asc" },
              include: { variable: true },
            },
            configAttachments: {
              orderBy: { targetPath: "asc" },
              include: { config: true },
            },
            secrets: {
              orderBy: { name: "asc" },
            },
          },
        },
      },
    });

    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }

    return appGroup;
  }

  private assertDraftCanBeDeployed(
    draft: DeployableDraft,
    force: boolean,
  ) {
    if (!force && !draft.hasPendingChanges) {
      throw new ConflictException("AppGroup has no pending changes");
    }

    const activeSingleApps = draft.singleApps.filter(
      (singleApp) => !singleApp.pendingDeletion,
    );

    if (activeSingleApps.length === 0) {
      throw new ConflictException("AppGroup has no active SingleApps");
    }

    const invalidEndpoints = activeSingleApps.flatMap((singleApp) =>
      singleApp.httpEndpoints.filter(
        (endpoint) =>
          endpoint.containerPort < 1 || endpoint.containerPort > 65535,
      ),
    );

    if (invalidEndpoints.length > 0) {
      throw new ConflictException("AppGroup has invalid HTTP endpoints");
    }
  }

  private buildStackConfigSnapshot(draft: DeployableDraft, note?: string) {
    return {
      appGroup: {
        id: draft.id,
        tenantId: draft.tenantId,
        name: draft.name,
        runtimeState: draft.runtimeState,
        runtimeDraftRevision: draft.runtimeDraftRevision,
      },
      note,
      singleApps: draft.singleApps
        .filter((singleApp) => !singleApp.pendingDeletion)
        .map((singleApp) => ({
          id: singleApp.id,
          name: singleApp.name,
          image: singleApp.image,
          registryId: singleApp.registryId,
          desiredReplicas: singleApp.desiredReplicas,
          runtimeState: singleApp.runtimeState,
          resources: {
            cpu: singleApp.cpu.toString(),
            memoryBytes: singleApp.memoryBytes.toString(),
            gpu: singleApp.gpu,
          },
          environment: this.jsonObjectToRecord(singleApp.environment),
          variables: singleApp.variableAttachments.map((attachment) => ({
            id: attachment.id,
            variableId: attachment.variableId,
            variableName: attachment.variable.name,
            targetName: attachment.targetName,
            value: attachment.variable.value,
          })),
          secrets: singleApp.secrets.map((secret) => ({
            id: secret.id,
            name: secret.name,
            valueVersion: secret.valueVersion,
          })),
          configs: singleApp.configAttachments.map((attachment) => ({
            id: attachment.id,
            configId: attachment.configId,
            configName: attachment.config.name,
            contentVersion: attachment.config.contentVersion,
            targetPath: attachment.targetPath,
            content: attachment.config.content,
          })),
          healthCheck: singleApp.healthCheck,
          entrypoint: singleApp.entrypoint,
          command: singleApp.command,
          workingDir: singleApp.workingDir,
          user: singleApp.user,
          readOnlyRootFilesystem: singleApp.readOnlyRootFilesystem,
          stopGracePeriodSeconds: singleApp.stopGracePeriodSeconds,
          restartPolicy: singleApp.restartPolicy,
          updatePolicy: singleApp.updatePolicy,
          httpEndpoints: singleApp.httpEndpoints.map((endpoint) => ({
            id: endpoint.id,
            name: endpoint.name,
            containerPort: endpoint.containerPort,
            protocolMode: endpoint.protocolMode,
            domains: endpoint.domains.map((domain) => ({
              id: domain.id,
              hostname: domain.hostname,
              tlsEnabled: domain.tlsEnabled,
              dnsStatus: domain.dnsStatus,
              certificateStatus: domain.certificateStatus,
            })),
          })),
          volumes: singleApp.volumeAttachments.map((attachment) => ({
            id: attachment.id,
            volumeId: attachment.volumeId,
            volumeName: attachment.volume.name,
            storagePath: attachment.volume.storagePath,
            dockerVolumeName: attachment.volume.dockerVolumeName,
            mountPath: attachment.mountPath,
            mode: attachment.mode,
          })),
        })),
    };
  }

  private async assertQuotaAllowsSingleAppChange(
    tenantId: string,
    nextSingleApp: {
      cpu: number;
      memoryBytes: number;
      gpu: number;
      desiredReplicas: number;
    },
    replacingSingleAppId?: string,
  ) {
    const quota = await this.prisma.quota.findUnique({
      where: { tenantId },
    });

    if (!quota) {
      return;
    }

    const currentSingleApps = await this.prisma.singleApp.findMany({
      where: {
        appGroup: { tenantId },
        pendingDeletion: false,
        id: replacingSingleAppId ? { not: replacingSingleAppId } : undefined,
      },
      select: {
        cpu: true,
        memoryBytes: true,
        gpu: true,
        desiredReplicas: true,
      },
    });

    const usage = currentSingleApps.reduce(
      (acc, singleApp) => ({
        cpu: acc.cpu + Number(singleApp.cpu) * singleApp.desiredReplicas,
        memoryBytes:
          acc.memoryBytes +
          Number(singleApp.memoryBytes) * singleApp.desiredReplicas,
        gpu: acc.gpu + singleApp.gpu * singleApp.desiredReplicas,
        singleApps: acc.singleApps + 1,
      }),
      { cpu: 0, memoryBytes: 0, gpu: 0, singleApps: 0 },
    );

    const requested = {
      cpu: usage.cpu + nextSingleApp.cpu * nextSingleApp.desiredReplicas,
      memoryBytes:
        usage.memoryBytes +
        nextSingleApp.memoryBytes * nextSingleApp.desiredReplicas,
      gpu: usage.gpu + nextSingleApp.gpu * nextSingleApp.desiredReplicas,
      singleApps: usage.singleApps + 1,
    };

    const violations = [
      this.quotaViolation("cpu", requested.cpu, Number(quota.cpu)),
      this.quotaViolation(
        "memory",
        requested.memoryBytes,
        Number(quota.memoryBytes),
      ),
      this.quotaViolation("gpu", requested.gpu, quota.gpu),
      this.quotaViolation(
        "maxSingleApps",
        requested.singleApps,
        quota.maxSingleApps,
      ),
    ].filter((violation) => violation !== undefined);

    if (violations.length > 0) {
      throw new ForbiddenException({
        message: "Quota exceeded",
        violations,
      });
    }
  }

  private quotaViolation(resource: string, requested: number, limit: number) {
    if (requested <= limit) {
      return undefined;
    }

    return {
      resource,
      limit,
      requested,
    };
  }

  private markAppGroupDraftChanged(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actorId: string,
  ) {
    return tx.appGroup.update({
      where: { id: appGroupId },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: {
          increment: 1,
        },
        updatedBy: actorId,
      },
    });
  }

  private handleKnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }

  private mapVolumeAttachment(attachment: VolumeAttachment) {
    return {
      ...attachment,
    };
  }

  private mapHttpEndpoint(
    endpoint: HttpEndpoint & { domains?: { id: string }[] },
  ) {
    return {
      ...endpoint,
      domainCount: endpoint.domains?.length ?? 0,
    };
  }

  private mapRuntimeConfig(
    environment: Prisma.JsonValue,
    secrets: SingleAppSecret[],
  ) {
    return {
      environment: this.jsonObjectToRecord(environment),
      secrets: secrets.map((secret) => ({
        id: secret.id,
        name: secret.name,
        description: secret.description,
        hasValue: true,
        valueVersion: secret.valueVersion,
        createdBy: secret.createdBy,
        updatedBy: secret.updatedBy,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      })),
    };
  }

  private mergeEnvironment(
    current: Prisma.JsonValue,
    changes: Record<string, string | null>,
  ): Prisma.InputJsonObject {
    const merged = this.jsonObjectToRecord(current);

    for (const [name, value] of Object.entries(changes)) {
      this.assertRuntimeConfigName(name);

      if (value === null) {
        delete merged[name];
        continue;
      }

      if (typeof value !== "string") {
        throw new BadRequestException("Environment values must be strings");
      }

      merged[name] = value;
    }

    return merged;
  }

  private assertRuntimeConfigName(name: string) {
    if (!RUNTIME_CONFIG_NAME_PATTERN.test(name) || name.length > 128) {
      throw new BadRequestException(`Invalid runtime config name: ${name}`);
    }
  }

  private jsonObjectToRecord(value: Prisma.JsonValue) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject | undefined {
    return value as Prisma.InputJsonObject | undefined;
  }
}
