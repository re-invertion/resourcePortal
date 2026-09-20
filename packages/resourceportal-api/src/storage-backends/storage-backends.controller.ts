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
import { SetStorageBackendMaintenanceDto } from "./dto/set-storage-backend-maintenance.dto";
import { StorageBackendsApiService } from "./storage-backends-api.service";

@Controller("platform/storage-backends")
@UseGuards(PlatformAdminGuard)
export class StorageBackendsController {
  constructor(
    private readonly service: StorageBackendsApiService,
    private readonly operations: OperationsService,
  ) {}

  @Get()
  list() {
    return this.service.listBackends();
  }

  @Get(":storageBackendId")
  get(@Param("storageBackendId", ParseUUIDPipe) storageBackendId: string) {
    return this.service.getBackend(storageBackendId);
  }

  @Post(":storageBackendId/validate")
  validate(
    @Param("storageBackendId", ParseUUIDPipe) storageBackendId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.enqueue({
      type: "STORAGE_BACKEND_VALIDATE",
      tenantId: null,
      resourceType: "StorageBackend",
      resourceId: storageBackendId,
      actor,
      input: {},
    });
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
