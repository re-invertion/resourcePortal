import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { BillingReadService } from "./billing-read.service";
import { BillingService } from "./billing.service";
import { BillingUsageService } from "./billing-usage.service";
import { PlatformBillingController } from "./platform-billing.controller";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [PlatformBillingController],
  providers: [BillingService, BillingReadService, BillingUsageService],
  exports: [BillingService, BillingReadService, BillingUsageService],
})
export class BillingModule {}
