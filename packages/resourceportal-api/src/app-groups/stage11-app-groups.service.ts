import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, RuntimeState } from "@prisma/client";
import { AuthenticatedUser } from "../auth/types";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { lockTenantQuota } from "../tenants/quota-concurrency";
import { VolumesService } from "../volumes/volumes.service";
import { mapSingleApp } from "./app-groups.view";
import { CreateSingleAppDto } from "./dto/create-single-app.dto";
import { UpdateSingleAppDto } from "./dto/update-single-app.dto";
import { Stage3AppGroupsService } from "./stage3-app-groups.service";

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

@Injectable()
export class Stage11AppGroupsService extends Stage3AppGroupsService {
  constructor(
    private readonly stage11Prisma: PrismaService,
    private readonly stage11Registries: RegistriesService,
    encryption: EncryptionService,
    secretStorage: SecretStorageService,
    stackRuntime: StackRuntimeService,
    volumesService: VolumesService,
    config: ConfigService,
  ) {
    super(
      stage11Prisma,
      stage11Registries,
      encryption,
      secretStorage,
      stackRuntime,
      volumesService,
      config,
    );
  }

  async createSingleApp(
    tenantId: string,
    appGroupId: string,
    dto: CreateSingleAppDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureStage11AppGroupBelongsToTenant(tenantId, appGroupId);
    await this.stage11Registries.assertRegistryCanBeUsedByImage(
      tenantId,
      dto.registryId,
      dto.image,
    );

    try {
      const singleApp = await this.stage11Prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, tenantId);
        await this.ensureStage11AppGroupBelongsToTenant(
          tenantId,
          appGroupId,
          tx,
        );
        await this.assertStage11QuotaAllowsSingleAppChange(
          tx,
          tenantId,
          {
            cpu: dto.cpu,
            memoryBytes: dto.memoryBytes,
            gpu: dto.gpu ?? 0,
            desiredReplicas: dto.desiredReplicas ?? 1,
          },
        );

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
            environment: this.stage11ToJsonObject(dto.environment) ?? {},
            healthCheck: this.stage11ToJsonObject(dto.healthCheck),
            entrypoint: dto.entrypoint,
            command: dto.command ?? [],
            workingDir: dto.workingDir,
            user: dto.user,
            readOnlyRootFilesystem: dto.readOnlyRootFilesystem ?? false,
            stopGracePeriodSeconds: dto.stopGracePeriodSeconds ?? 30,
            restartPolicy:
              this.stage11ToJsonObject(dto.restartPolicy) ??
              DEFAULT_RESTART_POLICY,
            updatePolicy:
              this.stage11ToJsonObject(dto.updatePolicy) ?? DEFAULT_UPDATE_POLICY,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });

        await tx.appGroup.update({
          where: { id: appGroupId },
          data: {
            hasPendingChanges: true,
            runtimeDraftRevision: { increment: 1 },
            updatedBy: actor.id,
          },
        });

        return created;
      });

      return mapSingleApp(singleApp);
    } catch (error) {
      this.handleStage11KnownConflict(error, "SingleApp name already exists");
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
    const existing = await this.findStage11SingleAppOrThrow(
      tenantId,
      appGroupId,
      singleAppId,
    );

    if (existing.pendingDeletion) {
      throw new ConflictException("SingleApp is pending deletion");
    }

    const preflightImage = dto.image ?? existing.image;
    const preflightRegistryId =
      dto.registryId === undefined ? existing.registryId : dto.registryId;
    await this.stage11Registries.assertRegistryCanBeUsedByImage(
      tenantId,
      preflightRegistryId,
      preflightImage,
    );

    try {
      const updated = await this.stage11Prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, tenantId);

        const current = await this.findStage11SingleAppOrThrow(
          tenantId,
          appGroupId,
          singleAppId,
          tx,
        );
        if (current.pendingDeletion) {
          throw new ConflictException("SingleApp is pending deletion");
        }

        const nextImage = dto.image ?? current.image;
        const nextRegistryId =
          dto.registryId === undefined ? current.registryId : dto.registryId;
        if (
          nextImage !== preflightImage ||
          nextRegistryId !== preflightRegistryId
        ) {
          await this.stage11Registries.assertRegistryCanBeUsedByImage(
            tenantId,
            nextRegistryId,
            nextImage,
          );
        }

        await this.assertStage11QuotaAllowsSingleAppChange(
          tx,
          tenantId,
          {
            cpu: dto.cpu ?? Number(current.cpu),
            memoryBytes: dto.memoryBytes ?? Number(current.memoryBytes),
            gpu: dto.gpu ?? current.gpu,
            desiredReplicas: dto.desiredReplicas ?? current.desiredReplicas,
          },
          singleAppId,
        );

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
            environment: this.stage11ToJsonObject(dto.environment),
            healthCheck: this.stage11ToJsonObject(dto.healthCheck),
            entrypoint: dto.entrypoint,
            command: dto.command,
            workingDir: dto.workingDir,
            user: dto.user,
            readOnlyRootFilesystem: dto.readOnlyRootFilesystem,
            stopGracePeriodSeconds: dto.stopGracePeriodSeconds,
            restartPolicy: this.stage11ToJsonObject(dto.restartPolicy),
            updatePolicy: this.stage11ToJsonObject(dto.updatePolicy),
            updatedBy: actor.id,
          },
        });

        await tx.appGroup.update({
          where: { id: appGroupId },
          data: {
            hasPendingChanges: true,
            runtimeDraftRevision: { increment: 1 },
            updatedBy: actor.id,
          },
        });

        return singleApp;
      });

      return mapSingleApp(updated);
    } catch (error) {
      this.handleStage11KnownConflict(error, "SingleApp name already exists");
      throw error;
    }
  }

  private async assertStage11QuotaAllowsSingleAppChange(
    tx: Prisma.TransactionClient,
    tenantId: string,
    nextSingleApp: {
      cpu: number;
      memoryBytes: number;
      gpu: number;
      desiredReplicas: number;
    },
    replacingSingleAppId?: string,
  ) {
    const quota = await tx.quota.findUnique({ where: { tenantId } });
    if (!quota) {
      return;
    }

    const currentSingleApps = await tx.singleApp.findMany({
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
      this.stage11QuotaViolation("cpu", requested.cpu, Number(quota.cpu)),
      this.stage11QuotaViolation(
        "memory",
        requested.memoryBytes,
        Number(quota.memoryBytes),
      ),
      this.stage11QuotaViolation("gpu", requested.gpu, quota.gpu),
      this.stage11QuotaViolation(
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

  private stage11QuotaViolation(
    resource: string,
    requested: number,
    limit: number,
  ) {
    if (requested <= limit) {
      return undefined;
    }

    return { resource, limit, requested };
  }

  private async ensureStage11AppGroupBelongsToTenant(
    tenantId: string,
    appGroupId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.stage11Prisma;
    const appGroup = await db.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      select: { id: true },
    });
    if (!appGroup) {
      throw new NotFoundException("App Group not found");
    }
  }

  private async findStage11SingleAppOrThrow(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.stage11Prisma;
    const singleApp = await db.singleApp.findFirst({
      where: {
        id: singleAppId,
        appGroup: { id: appGroupId, tenantId },
      },
    });
    if (!singleApp) {
      throw new NotFoundException("SingleApp not found");
    }
    return singleApp;
  }

  private stage11ToJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject | undefined {
    return value as Prisma.InputJsonObject | undefined;
  }

  private handleStage11KnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }
}
