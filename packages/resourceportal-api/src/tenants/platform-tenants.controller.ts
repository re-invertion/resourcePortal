import { Controller, Get, UseGuards } from "@nestjs/common";
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
}
