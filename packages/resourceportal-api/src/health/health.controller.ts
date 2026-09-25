import { Controller, Get, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "../auth/public.decorator";
import { WorkerRuntimeObservabilityService } from "../observability/worker-runtime-observability.service";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { PrismaService } from "../prisma/prisma.service";

@Public()
@AllowDuringPlatformMaintenance()
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly workerObservability?: WorkerRuntimeObservabilityService,
    @Optional()
    private readonly config?: ConfigService,
  ) {}

  @Get()
  async getHealth() {
    return this.getReadiness();
  }

  @Get("live")
  getLiveness() {
    const version = this.releaseVersion();
    return {
      status: "ok",
      service: "resource-portal-api",
      ...(version ? { version } : {}),
    };
  }

  @Get("worker")
  async getWorkerHealth() {
    if (!this.workerObservability) {
      return {
        status: "degraded",
        service: "resource-portal-worker",
        workers: { total: 0, active: 0, stale: 0 },
        reconciliations: { failing: 0 },
      };
    }
    return this.workerObservability.workerHealth();
  }

  @Get("ready")
  async getReadiness() {
    await this.prisma.$queryRaw`SELECT 1`;
    const version = this.releaseVersion();

    return {
      status: "ok",
      service: "resource-portal-api",
      ...(version ? { version } : {}),
      dependencies: {
        postgres: "ok",
      },
    };
  }

  private releaseVersion() {
    return this.config?.get<string>("RESOURCEPORTAL_VERSION")?.trim() || undefined;
  }
}
