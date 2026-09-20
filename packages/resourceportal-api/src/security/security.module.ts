import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EncryptionService } from "./encryption.service";
import { LegacySecretMigrationService } from "./legacy-secret-migration.service";
import { RateLimitService } from "./rate-limit.service";
import { SecretStorageService } from "./secret-storage.service";

@Module({
  imports: [PrismaModule],
  providers: [EncryptionService, LegacySecretMigrationService, RateLimitService, SecretStorageService],
  exports: [EncryptionService, LegacySecretMigrationService, RateLimitService, SecretStorageService],
})
export class SecurityModule {}
