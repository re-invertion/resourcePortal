import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { BillingReadService } from "./billing-read.service";
import { BillingService } from "./billing.service";
import { BillingUsageService } from "./billing-usage.service";
import { BillingWorkerService } from "./billing-worker.service";
import { PlatformBillingController } from "./platform-billing.controller";

@Module({
  imports: [PrismaModule],
  controllers: [PlatformBillingController],
  providers: [BillingService, BillingReadService, BillingUsageService, BillingWorkerService],
  exports: [BillingService, BillingReadService],
})
export class BillingModule {}
