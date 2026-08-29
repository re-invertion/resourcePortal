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

  @RequirePermissions("tenant_auth_policy.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.identityProvidersService.listTenantIdentityProviders(tenantId);
  }

  @RequirePermissions("tenant_auth_policy.read")
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

  @RequirePermissions("tenant_auth_policy.update")
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

  @RequirePermissions("tenant_auth_policy.update")
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

  @RequirePermissions("tenant_auth_policy.update")
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
