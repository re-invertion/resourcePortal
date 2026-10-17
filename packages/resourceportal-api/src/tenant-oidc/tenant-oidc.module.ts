import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TenantOidcController } from "./tenant-oidc.controller";
import { PlatformTenantOidcController } from "./platform-tenant-oidc.controller";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { TenantOidcAuditService } from "./tenant-oidc-audit.service";
import { TenantOidcService } from "./tenant-oidc.service";
import { TenantOidcAutoRolloutService } from "./tenant-oidc-auto-rollout.service";
import { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

@Module({
  imports: [PrismaModule],
  controllers: [TenantOidcController, PlatformTenantOidcController],
  providers: [TenantOidcService, TenantOidcAutoRolloutService, TenantOidcAuditService, ZitadelTenantProjectService, PlatformAdminGuard],
  exports: [TenantOidcService, TenantOidcAutoRolloutService],
})
export class TenantOidcModule {}
