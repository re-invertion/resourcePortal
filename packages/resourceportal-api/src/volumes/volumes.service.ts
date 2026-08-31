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
import { StorageBackendsService } from "../storage-backends/storage-backends.service";
import { lockTenantQuota } from "../tenants/quota-concurrency";
import { CreateVolumeDto } from "./dto/create-volume.dto";
import { ResizeVolumeDto } from "./dto/resize-volume.dto";
import { mapVolume } from "./volumes.view";

type VolumeWithAttachments = Prisma.VolumeGetPayload<{
  include: { attachments: true };
}>;

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
    let provisioned:
      | { backendId: string; storagePath: string }
      | undefined;

    try {
      const volume = await this.prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, tenantId);
        await this.assertQuotaAllowsVolumeChange(
          tx,
          tenantId,
          dto.sizeBytes,
        );

        provisioned = await this.storageBackends.provisionVolume({
          tenantId,
          volumeId,
          sizeBytes: BigInt(dto.sizeBytes),
        });

        return tx.volume.create({
          data: {
            id: volumeId,
            tenantId,
            name: dto.name,
            description: dto.description,
            storagePath: provisioned.storagePath,
            dockerVolumeName: this.dockerVolumeName(volumeId),
            sizeBytes: dto.sizeBytes,
            status: VolumeStatus.Ready,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          include: { attachments: true },
        });
      });

      return mapVolume(volume);
    } catch (error) {
      if (provisioned) {
        await this.storageBackends
          .cleanupProvisionedVolume(
            provisioned.backendId,
            provisioned.storagePath,
          )
          .catch(() => undefined);
      }
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
    const updated = await this.prisma.$transaction(async (tx) => {
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
        return volume;
      }

      await this.assertQuotaAllowsVolumeChange(
        tx,
        tenantId,
        dto.sizeBytes,
        volumeId,
      );

      await this.storageBackends.resizeVolume({
        volumeId,
        storagePath: volume.storagePath,
        requestedSizeBytes: requestedSize,
        currentSizeBytes: volume.sizeBytes,
      });

      return tx.volume.update({
        where: { id: volumeId },
        data: {
          sizeBytes: dto.sizeBytes,
          status: VolumeStatus.Ready,
          updatedBy: actor.id,
        },
        include: { attachments: true },
      });
    });

    return mapVolume(updated);
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

    const currentVolumes = await tx.volume.findMany({
      where: {
        tenantId,
        id: replacingVolumeId ? { not: replacingVolumeId } : undefined,
      },
      select: { sizeBytes: true },
    });

    const currentUsage = currentVolumes.reduce(
      (sum, volume) => sum + Number(volume.sizeBytes),
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
