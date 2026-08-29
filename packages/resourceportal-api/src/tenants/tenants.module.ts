import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import {
  TenantInvitationsController,
  TenantsController,
} from "./tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [PrismaModule],
  controllers: [TenantsController, TenantInvitationsController],
  providers: [TenantsService],
})
export class TenantsModule {}
