import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { NetworkEgressController } from "./network-egress.controller";
import { NetworkEgressModule } from "./network-egress.module";

@Module({
  imports: [PrismaModule, NetworkEgressModule],
  controllers: [NetworkEgressController],
  providers: [PlatformAdminGuard],
})
export class NetworkEgressApiModule {}
