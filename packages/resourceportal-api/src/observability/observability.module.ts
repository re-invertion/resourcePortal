import { Module } from "@nestjs/common";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityService } from "./observability.service";
import { TracingService } from "./tracing.service";

@Module({
  controllers: [ObservabilityController],
  providers: [ObservabilityService, TracingService],
  exports: [ObservabilityService, TracingService],
})
export class ObservabilityModule {}
