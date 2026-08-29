import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateVolumeDto } from "./dto/create-volume.dto";
import { ResizeVolumeDto } from "./dto/resize-volume.dto";
import { VolumesService } from "./volumes.service";

@Controller("tenants/:tenantId/volumes")
export class VolumesController {
  constructor(private readonly volumesService: VolumesService) {}

  @RequirePermissions("volume.read")
  @Get()
  listVolumes(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.volumesService.listVolumes(tenantId);
  }

  @RequirePermissions("volume.create")
  @Post()
  createVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateVolumeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.volumesService.createVolume(tenantId, dto, user);
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
  resizeVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("volumeId", ParseUUIDPipe) volumeId: string,
    @Body() dto: ResizeVolumeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.volumesService.resizeVolume(tenantId, volumeId, dto, user);
  }

  @RequirePermissions("volume.delete")
  @Delete(":volumeId")
  deleteVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("volumeId", ParseUUIDPipe) volumeId: string,
  ) {
    return this.volumesService.deleteVolume(tenantId, volumeId);
  }
}
