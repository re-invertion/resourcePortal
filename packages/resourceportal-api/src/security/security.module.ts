import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DeploymentArtifactSecurityMigrationService } from "./deployment-artifact-security-migration.service";
import { EncryptionService } from "./encryption.service";
import { LegacySecretMigrationService } from "./legacy-secret-migration.service";
import { RateLimitService } from "./rate-limit.service";
import { SecretStorageService } from "./secret-storage.service";

@Module({
  imports: [PrismaModule],
  providers: [DeploymentArtifactSecurityMigrationService, EncryptionService, LegacySecretMigrationService, RateLimitService, SecretStorageService],
  exports: [DeploymentArtifactSecurityMigrationService, EncryptionService, LegacySecretMigrationService, RateLimitService, SecretStorageService],
})
export class SecurityModule {}
