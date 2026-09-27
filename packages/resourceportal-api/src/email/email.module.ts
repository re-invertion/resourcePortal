import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { PlatformEmailController } from "./platform-email.controller";
import { PlatformEmailService } from "./platform-email.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [PlatformEmailController],
  providers: [PlatformAdminGuard, PlatformEmailService],
  exports: [PlatformEmailService],
})
export class EmailModule {}
