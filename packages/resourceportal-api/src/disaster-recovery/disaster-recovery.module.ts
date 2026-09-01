import { Module } from "@nestjs/common";
import { InternalModule } from "../internal/internal.module";
import { PlatformInfrastructureModule } from "../platform-infrastructure/platform-infrastructure.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageBackendsModule } from "../storage-backends/storage-backends.module";
import { DisasterRecoveryService } from "./disaster-recovery.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

@Module({
  imports: [
    PrismaModule,
    InternalModule,
    PlatformInfrastructureModule,
    StorageBackendsModule,
  ],
  providers: [DisasterRecoveryService, RuntimeRestoreService],
  exports: [DisasterRecoveryService],
})
export class DisasterRecoveryModule {}
