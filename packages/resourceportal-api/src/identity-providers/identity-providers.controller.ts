import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateIdentityProviderDto } from "./dto/create-identity-provider.dto";
import { UpdateIdentityProviderDto } from "./dto/update-identity-provider.dto";
import { IdentityProvidersService } from "./identity-providers.service";

@Controller("tenants/:tenantId/identity-providers")
export class IdentityProvidersController {
  constructor(private readonly identityProvidersService: IdentityProvidersService) {}

  @RequirePermissions("identity_provider.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.identityProvidersService.listTenantIdentityProviders(tenantId);
  }

  @RequirePermissions("identity_provider.read")
  @Get(":identityProviderId")
  get(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
  ) {
    return this.identityProvidersService.getTenantIdentityProvider(
      tenantId,
      identityProviderId,
    );
  }

  @RequirePermissions("identity_provider.create")
  @Post()
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateIdentityProviderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.identityProvidersService.createTenantIdentityProvider(
      tenantId,
      dto,
      actor,
    );
  }

  @RequirePermissions("identity_provider.update")
  @Patch(":identityProviderId")
  update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @Body() dto: UpdateIdentityProviderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.identityProvidersService.updateTenantIdentityProvider(
      tenantId,
      identityProviderId,
      dto,
      actor,
    );
  }

  @RequirePermissions("identity_provider.delete")
  @Delete(":identityProviderId")
  delete(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.identityProvidersService.deleteTenantIdentityProvider(
      tenantId,
      identityProviderId,
      actor,
    );
  }
}
