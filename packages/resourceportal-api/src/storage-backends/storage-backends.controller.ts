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
import { SetStorageBackendMaintenanceDto } from "./dto/set-storage-backend-maintenance.dto";
import { StorageBackendsService } from "./storage-backends.service";

@Controller("platform/storage-backends")
@UseGuards(PlatformAdminGuard)
export class StorageBackendsController {
  constructor(private readonly service: StorageBackendsService) {}

  @Get()
  list() {
    return this.service.listBackends();
  }

  @Get(":storageBackendId")
  get(@Param("storageBackendId", ParseUUIDPipe) storageBackendId: string) {
    return this.service.getBackend(storageBackendId);
  }

  @Post(":storageBackendId/validate")
  validate(@Param("storageBackendId", ParseUUIDPipe) storageBackendId: string) {
    return this.service.validateBackend(storageBackendId);
  }

  @Patch(":storageBackendId/maintenance")
  setMaintenance(
    @Param("storageBackendId", ParseUUIDPipe) storageBackendId: string,
    @Body() dto: SetStorageBackendMaintenanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.setMaintenance(storageBackendId, dto.enabled, actor);
  }
}
