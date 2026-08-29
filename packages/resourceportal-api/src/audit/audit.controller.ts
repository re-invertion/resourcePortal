import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuditService } from "./audit.service";
import { ListAuditLogDto } from "./dto/list-audit-log.dto";

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
}
