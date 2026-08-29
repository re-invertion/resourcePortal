import { Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { RateLimitService } from "./rate-limit.service";

@Module({
  providers: [EncryptionService, RateLimitService],
  exports: [EncryptionService, RateLimitService],
})
export class SecurityModule {}
