import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from "@nestjs/common";
import { FastifyReply } from "fastify";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuditService } from "./audit.service";
import {
  ExportAuditLogDto,
  ListAuditLogDto,
} from "./dto/list-audit-log.dto";

@Controller("tenants/:tenantId/audit-log")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermissions("audit.read")
  @Get()
  listAuditLog(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query() query: ListAuditLogDto,
  ) {
    return this.auditService.listAuditLog(tenantId, query);
  }

  @RequirePermissions("audit.export")
  @Get("export")
  async exportAuditLog(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query() query: ExportAuditLogDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const exported = await this.auditService.exportAuditLog(tenantId, query);
    reply.header("Content-Type", exported.contentType);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${exported.fileName}"`,
    );
    return exported.body;
  }
}
