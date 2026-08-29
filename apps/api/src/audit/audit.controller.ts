import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuditService } from "./audit.service";

@Controller("tenants/:tenantId/audit-log")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermissions("audit.read")
  @Get()
  listAuditLog(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.auditService.listAuditLog(tenantId);
  }
}
