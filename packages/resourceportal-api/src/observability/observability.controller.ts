import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { Public } from "../auth/public.decorator";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { ObservabilityService } from "./observability.service";
import { WorkerRuntimeObservabilityService } from "./worker-runtime-observability.service";

@Public()
@AllowDuringPlatformMaintenance()
@Controller("metrics")
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get()
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  getMetrics() {
    return this.observability.renderPrometheusMetrics();
  }
}

@Controller("platform/observability")
@UseGuards(PlatformAdminGuard)
@AllowDuringPlatformMaintenance()
export class ObservabilityDiagnosticsController {
  constructor(
    private readonly workerObservability: WorkerRuntimeObservabilityService,
  ) {}

  @Get("diagnostics")
  diagnostics() {
    return this.workerObservability.diagnostics();
  }
}
