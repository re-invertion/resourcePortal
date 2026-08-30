import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, VolumeStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { join } from "node:path";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateVolumeDto } from "./dto/create-volume.dto";
import { ResizeVolumeDto } from "./dto/resize-volume.dto";
import { VolumeStorageService } from "./volume-storage.service";
import { mapVolume } from "./volumes.view";

type VolumeWithAttachments = Prisma.VolumeGetPayload<{
  include: { attachments: true };
}>;

@Injectable()
export class VolumesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: VolumeStorageService,
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
    await this.assertQuotaAllowsVolumeChange(tenantId, dto.sizeBytes);
    const volumeId = randomUUID();

    try {
      const volume = await this.prisma.volume.create({
        data: {
          id: volumeId,
          tenantId,
          name: dto.name,
          description: dto.description,
          storagePath: this.storagePath(tenantId, volumeId),
          dockerVolumeName: this.dockerVolumeName(volumeId),
          sizeBytes: dto.sizeBytes,
          status: VolumeStatus.Ready,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { attachments: true },
      });

      return mapVolume(volume);
    } catch (error) {
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
    const volume = await this.findVolumeOrThrow(tenantId, volumeId);
    const currentSize = Number(volume.sizeBytes);

    if (dto.sizeBytes < currentSize) {
      throw new ConflictException("Volume cannot be shrunk");
    }

    if (dto.sizeBytes === currentSize) {
      return mapVolume(volume);
    }

    await this.assertQuotaAllowsVolumeChange(
      tenantId,
      dto.sizeBytes,
      volumeId,
    );

    const updated = await this.prisma.volume.update({
      where: { id: volumeId },
      data: {
        sizeBytes: dto.sizeBytes,
        status: VolumeStatus.Ready,
        updatedBy: actor.id,
      },
      include: { attachments: true },
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
      await this.storage.deleteVolumeData({
        tenantId,
        volumeId,
        storagePath: volume.storagePath,
        dockerVolumeName: volume.dockerVolumeName,
      });
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
    const usedSizeBytes = await this.storage.measureUsedSize(volume.storagePath);

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
    tenantId: string,
    requestedVolumeSizeBytes: number,
    replacingVolumeId?: string,
  ) {
    const quota = await this.prisma.quota.findUnique({
      where: { tenantId },
    });

    if (!quota) {
      return;
    }

    const currentVolumes = await this.prisma.volume.findMany({
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

  private storagePath(tenantId: string, volumeId: string) {
    const storageRoot = this.config.get<string>(
      "RESOURCE_STORAGE_ROOT",
      "/rp/volumes",
    );

    return join(storageRoot, tenantId, volumeId);
  }
}
