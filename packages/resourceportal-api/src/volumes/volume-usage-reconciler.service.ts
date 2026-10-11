import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageBackendsService } from "../storage-backends/storage-backends.service";

@Injectable()
export class VolumeUsageReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageBackendsService,
  ) {}

  // A stable, cursor-based sweep prevents unchanged or failing old volumes
  // from monopolizing every batch. The last attempted ID advances even when
  // a measurement fails; a subsequent batch wraps around after the last ID.
  private lastAttemptedVolumeId: string | null = null;

  async reconcileBatch(limit = 200) {
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit) || 200));
    const select = { id: true, storagePath: true, usedSizeBytes: true } as const;
    const query = (after: string | null) =>
      this.prisma.volume.findMany({
        where: { status: "Ready" as const, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: "asc" as const },
        take: safeLimit,
        select,
      });
    let volumes = await query(this.lastAttemptedVolumeId);
    if (volumes.length === 0 && this.lastAttemptedVolumeId !== null) {
      this.lastAttemptedVolumeId = null;
      volumes = await query(null);
    }
    let updated = 0;
    let failed = 0;
    for (const volume of volumes) {
      this.lastAttemptedVolumeId = volume.id;
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
