import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { NetworkEgressReconcilerService } from "./network-egress-reconciler.service";
import { NetworkEgressService } from "./network-egress.service";

@Module({
  imports: [PrismaModule],
  providers: [NetworkEgressService, NetworkEgressReconcilerService],
  exports: [NetworkEgressService, NetworkEgressReconcilerService],
})
export class NetworkEgressModule {}
