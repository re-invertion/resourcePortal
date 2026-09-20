import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import {
  ObservabilityController,
  ObservabilityDiagnosticsController,
} from "./observability.controller";
import { ObservabilityService } from "./observability.service";
import { TracingService } from "./tracing.service";
import { WorkerRuntimeObservabilityService } from "./worker-runtime-observability.service";

@Module({
  imports: [PrismaModule],
  controllers: [ObservabilityController, ObservabilityDiagnosticsController],
  providers: [
    ObservabilityService,
    TracingService,
    WorkerRuntimeObservabilityService,
    PlatformAdminGuard,
  ],
  exports: [ObservabilityService, TracingService, WorkerRuntimeObservabilityService],
})
export class ObservabilityModule {}
