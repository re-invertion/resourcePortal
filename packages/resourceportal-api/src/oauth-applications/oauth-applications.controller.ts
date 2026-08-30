import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateOAuthApplicationDto } from "./dto/create-oauth-application.dto";
import { UpdateOAuthApplicationDto } from "./dto/update-oauth-application.dto";
import { OAuthApplicationCredentialsService } from "./oauth-application-credentials.service";
import { OAuthApplicationsService } from "./oauth-applications.service";

@Controller("tenants/:tenantId/oauth-applications")
export class OAuthApplicationsController {
  constructor(
    private readonly service: OAuthApplicationsService,
    private readonly credentials: OAuthApplicationCredentialsService,
  ) {}

  @RequirePermissions("oauth_application.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.list(tenantId);
  }

  @RequirePermissions("oauth_application.read")
  @Get(":applicationId")
  get(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
  ) {
    return this.service.get(tenantId, applicationId);
  }

  @RequirePermissions("oauth_application.create")
  @Post()
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateOAuthApplicationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.create(tenantId, dto, actor);
  }

  @RequirePermissions("oauth_application.update")
  @Patch(":applicationId")
  update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @Body() dto: UpdateOAuthApplicationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(tenantId, applicationId, dto, actor);
  }

  @RequirePermissions("oauth_application.update")
  @Post(":applicationId/rotate-credentials")
  rotateCredentials(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.credentials.rotateTenant(tenantId, applicationId, actor);
  }

  @RequirePermissions("oauth_application.delete")
  @Delete(":applicationId")
  delete(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(tenantId, applicationId, actor);
  }
}
