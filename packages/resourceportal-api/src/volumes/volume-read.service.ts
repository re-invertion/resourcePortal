import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { mapVolume } from "./volumes.view";

@Injectable()
export class VolumeReadService {
  constructor(private readonly prisma: PrismaService) {}

  async listVolumes(tenantId: string) {
    const volumes = await this.prisma.volume.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return volumes.map(mapVolume);
  }

  async getVolume(tenantId: string, volumeId: string) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, tenantId },
    });
    if (!volume) throw new NotFoundException("Volume not found");
    return mapVolume(volume);
  }

  async assertVolumeBelongsToTenant(tenantId: string, volumeId: string) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, tenantId },
      select: { id: true },
    });
    if (!volume) throw new NotFoundException("Volume not found");
  }
}
