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

type VolumeWithAttachments = Prisma.VolumeGetPayload<{
  include: { attachments: true };
}>;

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
    const result = [];

    for (const volume of volumes) {
      result.push(mapVolume(await this.refreshUsedSize(volume)));
    }

    return result;
  }

  async getVolume(tenantId: string, volumeId: string) {
    const volume = await this.findVolumeOrThrow(tenantId, volumeId);
    return mapVolume(await this.refreshUsedSize(volume));
  }

  async createVolume(
    tenantId: string,
    dto: CreateVolumeDto,
    actor: AuthenticatedUser,
  ) {
    const volumeId = randomUUID();
    const sizeBytes = BigInt(dto.sizeBytes);
    let reservation: StorageBackendReservation | undefined;
    let provisionAttempted = false;

    await this.storageBackends.refreshDefaultBackendForWrite();

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, tenantId);
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
    const volume = await this.findVolumeOrThrow(tenantId, volumeId);

    if (volume.attachments.length > 0) {
      throw new ConflictException("VolumeInUse");
    }

    await this.prisma.volume.update({
      where: { id: volumeId },
      data: {
        status: VolumeStatus.Deleting,
        updatedBy: actor.id,
      },
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

  private async refreshUsedSize(volume: VolumeWithAttachments) {
    const usedSizeBytes = await this.storageBackends.measureUsedSize(
      volume.id,
      volume.storagePath,
    );

    if (volume.usedSizeBytes === usedSizeBytes) {
      return volume;
    }

    return this.prisma.volume.update({
      where: { id: volume.id },
      data: { usedSizeBytes },
      include: { attachments: true },
    });
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
