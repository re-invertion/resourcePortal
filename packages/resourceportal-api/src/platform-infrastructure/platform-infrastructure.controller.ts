import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import { SetRemoteLocationMaintenanceDto } from "./dto/set-maintenance.dto";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformInfrastructureController {
  constructor(private readonly service: SwarmInfrastructureService) {}

  @Get("swarm-cluster")
  getCluster() {
    return this.service.getCluster();
  }

  @Post("swarm-cluster/reconcile")
  reconcile() {
    return this.service.reconcile();
  }

  @Get("remote-locations")
  listRemoteLocations() {
    return this.service.listRemoteLocations();
  }

  @Get("remote-locations/:remoteLocationId")
  getRemoteLocation(
    @Param("remoteLocationId", ParseUUIDPipe) remoteLocationId: string,
  ) {
    return this.service.getRemoteLocation(remoteLocationId);
  }

  @Patch("remote-locations/:remoteLocationId/maintenance")
  setMaintenance(
    @Param("remoteLocationId", ParseUUIDPipe) remoteLocationId: string,
    @Body() dto: SetRemoteLocationMaintenanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.setMaintenance(remoteLocationId, dto.enabled, actor);
  }
}
