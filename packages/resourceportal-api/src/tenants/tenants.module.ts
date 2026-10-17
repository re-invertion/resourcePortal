import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { TenantOidcModule } from "../tenant-oidc/tenant-oidc.module";
import { EmailModule } from "../email/email.module";
import {
  TenantInvitationsController,
  TenantsController,
} from "./tenants.controller";
import { PlatformTenantsController } from "./platform-tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [PrismaModule, BillingModule, EmailModule, TenantOidcModule, AuthModule],
  controllers: [TenantsController, TenantInvitationsController, PlatformTenantsController],
  providers: [TenantsService, PlatformAdminGuard],
})
export class TenantsModule {}
