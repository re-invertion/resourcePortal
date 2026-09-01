import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformMaintenanceAuditService } from "./platform-maintenance-audit.service";
import { PlatformMaintenanceController } from "./platform-maintenance.controller";
import { PlatformMaintenanceService } from "./platform-maintenance.service";
import { PlatformMaintenanceStore } from "./platform-maintenance.store";

@Module({
  imports: [PrismaModule],
  controllers: [PlatformMaintenanceController],
  providers: [
    PlatformMaintenanceStore,
    PlatformMaintenanceAuditService,
    PlatformMaintenanceService,
  ],
  exports: [PlatformMaintenanceService],
})
export class PlatformMaintenanceModule {}
