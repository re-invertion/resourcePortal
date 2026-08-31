import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { CreateVolumeDto } from "./dto/create-volume.dto";
import { ResizeVolumeDto } from "./dto/resize-volume.dto";
import { VolumesService } from "./volumes.service";

@Controller("tenants/:tenantId/volumes")
export class VolumesController {
  constructor(
    private readonly volumesService: VolumesService,
    private readonly operationsService: OperationsService,
  ) {}

  @RequirePermissions("volume.read")
  @Get()
  listVolumes(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.volumesService.listVolumes(tenantId);
  }

  @RequirePermissions("volume.create")
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  createVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: CreateVolumeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.operationsService.enqueue({
      type: "VOLUME_CREATE",
      tenantId,
      resourceType: "Volume",
      actor: user,
      input: { dto },
      idempotencyKey,
    });
  }

  @RequirePermissions("volume.read")
  @Get(":volumeId")
  getVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("volumeId", ParseUUIDPipe) volumeId: string,
  ) {
    return this.volumesService.getVolume(tenantId, volumeId);
  }

  @RequirePermissions("volume.update")
  @Patch(":volumeId/resize")
  @HttpCode(HttpStatus.ACCEPTED)
  resizeVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("volumeId", ParseUUIDPipe) volumeId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: ResizeVolumeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.operationsService.enqueue({
      type: "VOLUME_RESIZE",
      tenantId,
      resourceType: "Volume",
      resourceId: volumeId,
      actor: user,
      input: { dto },
      idempotencyKey,
    });
  }

  @RequirePermissions("volume.delete")
  @Delete(":volumeId")
  @HttpCode(HttpStatus.ACCEPTED)
  deleteVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("volumeId", ParseUUIDPipe) volumeId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.operationsService.enqueue({
      type: "VOLUME_DELETE",
      tenantId,
      resourceType: "Volume",
      resourceId: volumeId,
      actor: user,
      input: {},
      idempotencyKey,
    });
  }
}
