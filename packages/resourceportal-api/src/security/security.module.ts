import { Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { RateLimitService } from "./rate-limit.service";
import { SecretStorageService } from "./secret-storage.service";

@Module({
  providers: [EncryptionService, RateLimitService, SecretStorageService],
  exports: [EncryptionService, RateLimitService, SecretStorageService],
})
export class SecurityModule {}
