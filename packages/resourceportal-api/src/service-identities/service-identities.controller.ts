import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateServiceIdentityDto } from "./dto/create-service-identity.dto";
import { UpdateServiceIdentityDto } from "./dto/update-service-identity.dto";
import { ServiceIdentitiesService } from "./service-identities.service";

@Controller("tenants/:tenantId/service-identities")
export class ServiceIdentitiesController {
  constructor(private readonly service: ServiceIdentitiesService) {}

  @RequirePermissions("service_identity.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.list(tenantId);
  }

  @RequirePermissions("service_identity.read")
  @Get(":serviceIdentityId")
  get(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
  ) {
    return this.service.get(tenantId, serviceIdentityId);
  }

  @RequirePermissions("service_identity.create")
  @Post()
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateServiceIdentityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.create(tenantId, dto, actor);
  }

  @RequirePermissions("service_identity.update")
  @Patch(":serviceIdentityId")
  update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
    @Body() dto: UpdateServiceIdentityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(tenantId, serviceIdentityId, dto, actor);
  }

  @RequirePermissions("service_identity.delete")
  @Delete(":serviceIdentityId")
  delete(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(tenantId, serviceIdentityId, actor);
  }
}
