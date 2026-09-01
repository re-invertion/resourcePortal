import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { PrismaService } from "../prisma/prisma.service";

@Public()
@AllowDuringPlatformMaintenance()
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getHealth() {
    return this.getReadiness();
  }

  @Get("live")
  getLiveness() {
    return {
      status: "ok",
      service: "resource-portal-api",
    };
  }

  @Get("ready")
  async getReadiness() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      status: "ok",
      service: "resource-portal-api",
      dependencies: {
        postgres: "ok",
      },
    };
  }
}
