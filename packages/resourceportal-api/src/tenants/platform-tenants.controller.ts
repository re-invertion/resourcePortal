import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthenticatedUser } from "../auth/types";
import { UpdateQuotaDto } from "./dto/update-quota.dto";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { TenantsService } from "./tenants.service";

@Controller("platform/tenants")
@UseGuards(PlatformAdminGuard)
export class PlatformTenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  listTenants() {
    return this.tenantsService.listPlatformTenants();
  }

  @Patch(":tenantId/quota")
  updateQuota(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateQuotaDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenantsService.updateQuota(tenantId, dto, actor);
  }
}
