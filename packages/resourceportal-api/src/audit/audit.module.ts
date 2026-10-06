import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import { PlatformAuditController } from "./platform-audit.controller";

@Module({
  imports: [PrismaModule],
  controllers: [AuditController, PlatformAuditController],
  providers: [AuditService],
})
export class AuditModule {}
