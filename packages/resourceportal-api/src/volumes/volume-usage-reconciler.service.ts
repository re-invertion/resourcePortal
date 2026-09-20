import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageBackendsService } from "../storage-backends/storage-backends.service";

@Injectable()
export class VolumeUsageReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageBackendsService,
  ) {}

  async reconcileBatch(limit = 200) {
    const volumes = await this.prisma.volume.findMany({
      where: { status: "Ready" },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, storagePath: true, usedSizeBytes: true },
    });
    let updated = 0;
    let failed = 0;
    for (const volume of volumes) {
      try {
        const usedSizeBytes = await this.storage.measureUsedSize(
          volume.id,
          volume.storagePath,
        );
        if (usedSizeBytes !== volume.usedSizeBytes) {
          await this.prisma.volume.update({
            where: { id: volume.id },
            data: { usedSizeBytes },
          });
          updated += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { scanned: volumes.length, updated, failed };
  }
}
