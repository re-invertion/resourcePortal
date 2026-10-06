import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { FastifyReply } from "fastify";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuditService } from "./audit.service";
import {
  ExportAuditLogDto,
  ListAuditLogDto,
} from "./dto/list-audit-log.dto";

@Controller("platform/audit-log")
@UseGuards(PlatformAdminGuard)
export class PlatformAuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  listAuditLog(@Query() query: ListAuditLogDto) {
    return this.auditService.listPlatformAuditLog(query);
  }

  @Get("export")
  async exportAuditLog(
    @Query() query: ExportAuditLogDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const exported = await this.auditService.exportPlatformAuditLog(query);
    reply.header("Content-Type", exported.contentType);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${exported.fileName}"`,
    );
    return exported.body;
  }
}
