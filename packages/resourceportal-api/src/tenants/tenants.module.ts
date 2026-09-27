import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import {
  TenantInvitationsController,
  TenantsController,
} from "./tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [PrismaModule, BillingModule, EmailModule],
  controllers: [TenantsController, TenantInvitationsController],
  providers: [TenantsService],
})
export class TenantsModule {}
