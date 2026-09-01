import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import { AllowDuringPlatformMaintenance } from "./allow-during-platform-maintenance.decorator";
import { SetPlatformMaintenanceDto } from "./dto/set-platform-maintenance.dto";
import { PlatformMaintenanceService } from "./platform-maintenance.service";

@Controller("platform/maintenance")
@UseGuards(PlatformAdminGuard)
@AllowDuringPlatformMaintenance()
export class PlatformMaintenanceController {
  constructor(private readonly maintenance: PlatformMaintenanceService) {}

  @Get()
  getState() {
    return this.maintenance.getState();
  }

  @Patch()
  setState(
    @Body() dto: SetPlatformMaintenanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.maintenance.setState(dto.enabled, dto.reason, actor);
  }
}
