import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { TenantOidcModule } from "../tenant-oidc/tenant-oidc.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [PrismaModule, ObservabilityModule, TenantOidcModule],
  controllers: [HealthController],
})
export class HealthModule {}
