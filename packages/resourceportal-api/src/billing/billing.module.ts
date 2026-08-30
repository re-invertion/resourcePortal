import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { BillingService } from "./billing.service";
import { BillingWorkerService } from "./billing-worker.service";
import { PlatformBillingController } from "./platform-billing.controller";

@Module({
  imports: [PrismaModule],
  controllers: [PlatformBillingController],
  providers: [BillingService, BillingWorkerService],
  exports: [BillingService],
})
export class BillingModule {}
