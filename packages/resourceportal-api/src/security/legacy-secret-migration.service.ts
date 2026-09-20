import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SecretStorageService } from "./secret-storage.service";

type MigrationStats = {
  scanned: number;
  migrated: number;
  cleaned: number;
  failed: number;
};

@Injectable()
export class LegacySecretMigrationService {
  private readonly logger = new Logger(LegacySecretMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SecretStorageService,
  ) {}

  async migrateAll(batchSize = 100): Promise<MigrationStats> {
    const safeBatchSize = Math.min(500, Math.max(1, Math.floor(batchSize)));
    const failedIds: string[] = [];
    const stats: MigrationStats = { scanned: 0, migrated: 0, cleaned: 0, failed: 0 };

    while (true) {
      const secrets = await this.prisma.secret.findMany({
        where: {
          storagePath: { not: null },
          ...(failedIds.length > 0 ? { id: { notIn: failedIds } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: safeBatchSize,
        select: {
          id: true,
          valueVersion: true,
          valueCiphertext: true,
          storagePath: true,
        },
      });
      if (secrets.length === 0) break;

      for (const secret of secrets) {
        stats.scanned += 1;
        if (!secret.storagePath) continue;
        const storagePath = secret.storagePath;
        const wasLegacyOnly = !secret.valueCiphertext;
        try {
          const databaseReady = await this.ensureDatabasePayload({
            ...secret,
            storagePath,
          });
          if (!databaseReady) continue;
          if (wasLegacyOnly) stats.migrated += 1;

          // Database is authoritative before the old file is removed. If the
          // process dies here, the next pass only repeats cleanup.
          await this.storage.removeLegacy(storagePath);
          const cleared = await this.prisma.secret.updateMany({
            where: {
              id: secret.id,
              storagePath,
              valueCiphertext: { not: null },
            },
            data: { storagePath: null },
          });
          if (cleared.count === 1) stats.cleaned += 1;
        } catch (error) {
          stats.failed += 1;
          failedIds.push(secret.id);
          this.logger.error(
            JSON.stringify({
              event: "legacy-secret-migration.failed",
              secretId: secret.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }

    return stats;
  }

  private async ensureDatabasePayload(secret: {
    id: string;
    valueVersion: number;
    valueCiphertext: string | null;
    storagePath: string;
  }) {
    if (secret.valueCiphertext) return true;

    // Copy the already encrypted and authenticated v0.1.x envelope. Validation
    // decrypts it once with the current master key before committing it to DB.
    const valueCiphertext = await this.storage.readLegacyEnvelope(secret.storagePath);
    const updated = await this.prisma.secret.updateMany({
      where: {
        id: secret.id,
        valueVersion: secret.valueVersion,
        valueCiphertext: null,
        storagePath: secret.storagePath,
      },
      data: {
        valueCiphertext,
        keyVersion: 1,
      },
    });
    if (updated.count === 1) return true;

    // Another execution may have won the compare-and-set. Never delete the
    // legacy file unless PostgreSQL is confirmed to contain the payload.
    const current = await this.prisma.secret.findUnique({
      where: { id: secret.id },
      select: { valueCiphertext: true },
    });
    return Boolean(current?.valueCiphertext);
  }
}
