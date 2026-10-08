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
import { OperationsService } from "../operations/operations.service";
import { RequestPlatformUpdateDto } from "./dto/request-platform-update.dto";
import { SetRemoteLocationMaintenanceDto } from "./dto/set-maintenance.dto";
import { PlatformReleaseService } from "./platform-release.service";
import { SwarmInfrastructureReadService } from "./swarm-infrastructure-read.service";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformInfrastructureController {
  constructor(
    private readonly service: SwarmInfrastructureReadService,
    private readonly operations: OperationsService,
    private readonly releases: PlatformReleaseService,
  ) {}

  @Get("release")
  getReleaseStatus() {
    return this.releases.status();
  }

  @Post("release/update")
  updateRelease(
    @Body() dto: RequestPlatformUpdateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.releases.requestUpdate(dto, actor);
  }

  @Get("swarm-cluster")
  getCluster() {
    return this.service.getCluster();
  }

  @Post("swarm-cluster/reconcile")
  reconcile(@CurrentUser() actor: AuthenticatedUser) {
    return this.operations.enqueue({
      type: "SWARM_RECONCILE",
      tenantId: null,
      resourceType: "SwarmCluster",
      actor,
      input: {},
    });
  }

  @Get("remote-locations")
  listRemoteLocations() {
    return this.service.listRemoteLocations();
  }

  @Get("resource-usage")
  getResourceUsage() {
    return this.service.getResourceUsage();
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
    return this.operations.enqueue({
      type: "SWARM_NODE_MAINTENANCE",
      tenantId: null,
      resourceType: "RemoteLocation",
      resourceId: remoteLocationId,
      actor,
      input: { enabled: dto.enabled },
    });
  }
}
