import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformDnsController } from "./platform-dns.controller";
import { PlatformDnsModule } from "./platform-dns.module";

@Module({
  imports: [PrismaModule, PlatformDnsModule],
  controllers: [PlatformDnsController],
  providers: [PlatformAdminGuard],
})
export class PlatformDnsApiModule {}
