import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, VolumeStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import {
  StorageBackendReservation,
  StorageBackendsService,
} from "../storage-backends/storage-backends.service";
import { lockTenantQuota } from "../tenants/quota-concurrency";
import { CreateVolumeDto } from "./dto/create-volume.dto";
import { ResizeVolumeDto } from "./dto/resize-volume.dto";
import { mapVolume } from "./volumes.view";
import { couldDeploymentStillMountVolume } from "./deployed-volume-reference";

type ReservedVolumeSizeRow = {
  id: string;
  reservedSizeBytes: bigint;
};

@Injectable()
export class VolumesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageBackends: StorageBackendsService,
  ) {}

  async listVolumes(tenantId: string) {
    const volumes = await this.prisma.volume.findMany({
      where: { tenantId },
      include: { attachments: true },
      orderBy: { createdAt: "desc" },
    });
    return volumes.map(mapVolume);
  }

  async getVolume(tenantId: string, volumeId: string) {
    return mapVolume(await this.findVolumeOrThrow(tenantId, volumeId));
  }

  async createVolume(
    tenantId: string,
    dto: CreateVolumeDto,
    actor: AuthenticatedUser,
    operationId?: string,
  ) {
    // The durable operation ID is also the volume identity. Retries must not
    // create a second volume or collide with the first one's tenant name.
    const volumeId = operationId ?? randomUUID();
    const sizeBytes = BigInt(dto.sizeBytes);
    let reservation: StorageBackendReservation | undefined;
    let provisionAttempted = false;
    let resumed = false;
    let hasExistingResource = false;
    let existingReady: Awaited<ReturnType<typeof this.findVolumeOrThrow>> | undefined;

    await this.storageBackends.refreshDefaultBackendForWrite();

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, tenantId);
        if (operationId) {
          const existing = await tx.volume.findUnique({
            where: { id: volumeId }, include: { attachments: true },
          });
          if (existing) {
            hasExistingResource = true;
            if (existing.tenantId !== tenantId || existing.createdBy !== actor.id ||
                existing.name !== dto.name || existing.sizeBytes !== sizeBytes ||
                (existing.description ?? null) !== (dto.description ?? null)) {
              throw new ConflictException("VolumeOperationReplayMismatch");
            }
            if (existing.status === VolumeStatus.Ready) {
              existingReady = existing;
              return;
            }
            if (existing.status === VolumeStatus.Creating) {
              resumed = true;
              return;
            }
            throw new ConflictException("VolumeOperationReplayInvalidState");
          }
        }
        await this.assertQuotaAllowsVolumeChange(
          tx,
          tenantId,
          dto.sizeBytes,
        );

        reservation = await this.storageBackends.reserveVolume(tx, {
          tenantId,
          volumeId,
          sizeBytes,
        });

        await tx.volume.create({
          data: {
            id: volumeId,
            tenantId,
            storageBackendId: reservation.backend.id,
            storageProjectId: reservation.projectId,
            name: dto.name,
            description: dto.description,
            storagePath: reservation.storagePath,
            dockerVolumeName: this.dockerVolumeName(volumeId),
            sizeBytes: dto.sizeBytes,
            status: VolumeStatus.Creating,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
      });

      if (existingReady) return mapVolume(existingReady);
      if (resumed) {
        const current = await this.findVolumeOrThrow(tenantId, volumeId);
        reservation = await this.storageBackends.recoverVolumeReservation(
          volumeId, current.storagePath, current.storageProjectId,
        );
      }
      if (!reservation) {
        throw new Error("StorageBackend reservation was not created");
      }

      provisionAttempted = true;
      await this.storageBackends.provisionVolume(reservation, {
        tenantId,
        volumeId,
        sizeBytes,
      });

      const volume = await this.prisma.volume.update({
        where: { id: volumeId },
        data: {
          status: VolumeStatus.Ready,
          updatedBy: actor.id,
        },
        include: { attachments: true },
      });
      return mapVolume(volume);
    } catch (error) {
      if (hasExistingResource && !resumed) {
        // A conflicting replay must never delete or mutate the completed volume.
        throw error;
      }
      if (resumed) {
        // The resumed volume may already contain persistent tenant data.
        // Never delete it after a failed retry; preserve for diagnosis/recovery.
        await this.prisma.volume.update({
          where: { id: volumeId }, data: { status: VolumeStatus.Error, updatedBy: actor.id },
        }).catch(() => undefined);
        throw error;
      }
      if (reservation && provisionAttempted) {
        const cleaned = await this.storageBackends
          .cleanupProvisionedVolume(
            reservation.backend,
            reservation.storagePath,
          )
          .then(() => true)
          .catch(() => false);

        if (!cleaned) {
          await this.prisma.volume
            .update({
              where: { id: volumeId },
              data: { status: VolumeStatus.Error, updatedBy: actor.id },
            })
            .catch(() => undefined);
          throw error;
        }
      }

      await this.prisma.volume
        .deleteMany({ where: { id: volumeId } })
        .catch(() => undefined);
      this.handleKnownConflict(error, "Volume name already exists");
      throw error;
    }
  }

  async resizeVolume(
    tenantId: string,
    volumeId: string,
    dto: ResizeVolumeDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.findVolumeOrThrow(tenantId, volumeId);
    const initiallyRequestedSize = BigInt(dto.sizeBytes);
    if (initiallyRequestedSize < current.sizeBytes) {
      throw new ConflictException("Volume cannot be shrunk");
    }
    if (initiallyRequestedSize === current.sizeBytes) {
      return mapVolume(current);
    }

    await this.storageBackends.refreshVolumeBackendForWrite(volumeId);

    const reserved = await this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, tenantId);

      const volume = await tx.volume.findFirst({
        where: { id: volumeId, tenantId },
        include: { attachments: true },
      });
      if (!volume) {
        throw new NotFoundException("Volume not found");
      }

      const requestedSize = BigInt(dto.sizeBytes);
      if (requestedSize < volume.sizeBytes) {
        throw new ConflictException("Volume cannot be shrunk");
      }
      if (requestedSize === volume.sizeBytes) {
        return { reservation: null, volume };
      }

      await this.assertQuotaAllowsVolumeChange(
        tx,
        tenantId,
        dto.sizeBytes,
        volumeId,
      );

      const resizeReservation = await this.storageBackends.reserveResize(tx, {
        volumeId,
        storagePath: volume.storagePath,
        requestedSizeBytes: requestedSize,
        currentSizeBytes: volume.sizeBytes,
        actorId: actor.id,
      });

      return { reservation: resizeReservation, volume };
    });

    if (!reserved.reservation) {
      return mapVolume(reserved.volume);
    }

    try {
      await this.storageBackends.resizeVolume(reserved.reservation, {
        storagePath: reserved.volume.storagePath,
        requestedSizeBytes: initiallyRequestedSize,
      });
      await this.storageBackends.completeResize(
        volumeId,
        initiallyRequestedSize,
        actor.id,
      );
    } catch (error) {
      await this.storageBackends.failResize(volumeId, actor.id).catch(() => undefined);
      throw error;
    }

    return mapVolume(await this.findVolumeOrThrow(tenantId, volumeId));
  }

  async deleteVolume(
    tenantId: string,
    volumeId: string,
    actor: AuthenticatedUser,
  ) {
    // Mark Deleting under the tenant quota/attachment lock, checking *deployed*
    // mounts rather than only the mutable draft attachment list.
    const volume = await this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, tenantId);
      const current = await tx.volume.findFirst({
        where: { id: volumeId, tenantId },
        include: { attachments: true },
      });
      if (!current) throw new NotFoundException("Volume not found");
      if (
        current.status !== VolumeStatus.Ready &&
        current.status !== VolumeStatus.Error
      ) throw new ConflictException("VolumeNotReadyForDeletion");
      if (current.attachments.length) throw new ConflictException("VolumeInUse");

      // A deployment may still mount this volume long after a draft detach.
      const groups = await tx.appGroup.findMany({
        where: { tenantId },
        select: {
          currentDeploymentVersion: true,
          driftStatus: true,
          lastObservedAt: true,
          deployments: {
            select: {
              version: true,
              status: true,
              stackConfig: true,
              completedAt: true,
            },
          },
        },
      });
      if (couldDeploymentStillMountVolume(groups, volumeId)) {
        throw new ConflictException("VolumeInUse");
      }

      const pendingOperations = await tx.operation.findFirst({
        where: {
          tenantId,
          type: { in: ["APP_GROUP_DEPLOY", "APP_GROUP_ROLLBACK"] },
          status: { in: ["Pending", "Running", "RollingBack"] },
        },
        select: { id: true },
      });
      if (pendingOperations) throw new ConflictException("VolumeInUse");

      await tx.volume.update({
        where: { id: volumeId },
        data: { status: VolumeStatus.Deleting, updatedBy: actor.id },
      });
      return current;
    });

    try {
      await this.storageBackends.deleteVolume(volumeId, volume.storagePath);
    } catch (error) {
      await this.prisma.volume
        .update({
          where: { id: volumeId },
          data: {
            status: VolumeStatus.Error,
            updatedBy: actor.id,
          },
        })
        .catch(() => undefined);
      throw error;
    }

    await this.prisma.volume.delete({
      where: { id: volumeId },
    });

    return { deleted: true };
  }

  async assertVolumeBelongsToTenant(tenantId: string, volumeId: string) {
    await this.findVolumeOrThrow(tenantId, volumeId);
  }


  private async findVolumeOrThrow(tenantId: string, volumeId: string) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, tenantId },
      include: { attachments: true },
    });

    if (!volume) {
      throw new NotFoundException("Volume not found");
    }

    return volume;
  }

  private async assertQuotaAllowsVolumeChange(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestedVolumeSizeBytes: number,
    replacingVolumeId?: string,
  ) {
    const quota = await tx.quota.findUnique({
      where: { tenantId },
    });

    if (!quota) {
      return;
    }

    const exclusion = replacingVolumeId
      ? Prisma.sql`AND "id" <> ${replacingVolumeId}::uuid`
      : Prisma.empty;
    const currentVolumes = await tx.$queryRaw<ReservedVolumeSizeRow[]>(
      Prisma.sql`
        SELECT
          "id",
          COALESCE("pendingSizeBytes", "sizeBytes")::bigint AS "reservedSizeBytes"
        FROM "Volume"
        WHERE "tenantId" = ${tenantId}::uuid
        ${exclusion}
      `,
    );

    const currentUsage = currentVolumes.reduce(
      (sum, volume) => sum + Number(volume.reservedSizeBytes),
      0,
    );
    const requestedStorage = currentUsage + requestedVolumeSizeBytes;
    const requestedVolumeCount = currentVolumes.length + 1;

    const violations = [
      this.quotaViolation(
        "storage",
        requestedStorage,
        Number(quota.storageBytes),
      ),
      this.quotaViolation(
        "maxVolumes",
        requestedVolumeCount,
        quota.maxVolumes,
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

  private handleKnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }

  private dockerVolumeName(volumeId: string) {
    return `rp_vol_${volumeId.replaceAll("-", "_")}`;
  }
}
