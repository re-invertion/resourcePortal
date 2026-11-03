import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { CapacityTelemetryService } from "../capacity/capacity-telemetry.service";
import { RequestPlatformUpdateDto } from "./dto/request-platform-update.dto";
import { SetRemoteLocationMaintenanceDto } from "./dto/set-maintenance.dto";
import { PlatformReleaseService } from "./platform-release.service";
import { SwarmInfrastructureReadService } from "./swarm-infrastructure-read.service";
import { NvidiaGpuAllocationService } from "./nvidia-gpu-allocation.service";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformInfrastructureController {
  constructor(
    private readonly service: SwarmInfrastructureReadService,
    private readonly operations: OperationsService,
    private readonly releases: PlatformReleaseService,
    private readonly capacity: CapacityTelemetryService,
    @Optional() private readonly gpu?: NvidiaGpuAllocationService,
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

  @Get("gpu-devices")
  listGpuDevices() {
    if (!this.gpu) throw new ServiceUnavailableException("GpuInventoryUnavailable");
    return this.gpu.listInventory();
  }

  @Post("gpu-devices/:gpuUuid/diagnose")
  diagnoseGpu(
    @Param("gpuUuid") gpuUuid: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    this.assertGpuUuid(gpuUuid);
    return this.operations.enqueue({
      type: "SWARM_GPU_DIAGNOSE", tenantId: null,
      resourceType: "GpuDevice", resourceId: gpuUuid,
      actor, input: {}, maxAttempts: 1,
    });
  }

  @Post("gpu-devices/:gpuUuid/recover")
  recoverGpu(
    @Param("gpuUuid") gpuUuid: string,
    @Body() body: { releaseIfUnavailable?: boolean },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    this.assertGpuUuid(gpuUuid);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "releaseIfUnavailable") ||
        (body.releaseIfUnavailable !== undefined &&
          typeof body.releaseIfUnavailable !== "boolean")) {
      throw new BadRequestException("InvalidGpuRecoveryInput");
    }
    return this.operations.enqueue({
      type: "SWARM_GPU_RECOVER", tenantId: null,
      resourceType: "GpuDevice", resourceId: gpuUuid,
      actor, input: { releaseIfUnavailable: body.releaseIfUnavailable === true },
      maxAttempts: 1,
    });
  }

  private assertGpuUuid(gpuUuid: string) {
    if (!/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(gpuUuid)) {
      throw new BadRequestException("InvalidGpuUuid");
    }
  }

  @Get("remote-locations")
  listRemoteLocations() {
    return this.service.listRemoteLocations();
  }

  @Get("resource-usage")
  getResourceUsage() {
    return this.service.getResourceUsage();
  }

  @Get("capacity")
  getCapacityDiagnostics() {
    return this.capacity.diagnostics();
  }

  @Patch("capacity/settings")
  async updateCapacitySettings(@Body() body: Record<string, unknown>) {
    try {
      return await this.capacity.updatePolicy(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid capacity settings",
      );
    }
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
