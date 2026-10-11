import { Module } from "@nestjs/common";
import { WorkerExecutionModule } from "../worker-execution.module";
import { PlatformInfrastructureModule } from "../platform-infrastructure/platform-infrastructure.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformMaintenanceModule } from "../platform-maintenance/platform-maintenance.module";
import { StorageBackendsModule } from "../storage-backends/storage-backends.module";
import { DisasterRecoveryService } from "./disaster-recovery.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

@Module({
  imports: [
    PrismaModule,
    PlatformMaintenanceModule,
    WorkerExecutionModule,
    PlatformInfrastructureModule,
    StorageBackendsModule,
  ],
  providers: [DisasterRecoveryService, RuntimeRestoreService],
  exports: [DisasterRecoveryService],
})
export class DisasterRecoveryModule {}
