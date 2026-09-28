import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { BugReportsController } from "./bug-reports.controller";
import { BugReportsService } from "./bug-reports.service";
import { PlatformBugReportsController } from "./platform-bug-reports.controller";

@Module({
  imports: [PrismaModule],
  controllers: [BugReportsController, PlatformBugReportsController],
  providers: [BugReportsService, PlatformAdminGuard],
})
export class BugReportsModule {}
