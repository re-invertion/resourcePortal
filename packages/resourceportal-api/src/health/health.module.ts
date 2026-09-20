import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  controllers: [HealthController],
})
export class HealthModule {}
