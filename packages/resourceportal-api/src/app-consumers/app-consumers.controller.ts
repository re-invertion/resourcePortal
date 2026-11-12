import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { IsUUID } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { AppConsumersService, NativeClientKey } from "./app-consumers.service";

class AppGrantDto {
  @IsUUID()
  applicationId!: string;
}

/** Legacy endpoint is an alias over the unified membership grant catalog. */
@Controller(["tenants/:tenantId/app-consumers", "tenants/:tenantId/membership-app-grants"])
export class AppConsumersController {
  constructor(private readonly service: AppConsumersService) {}

  @RequirePermissions("membership.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.list(tenantId);
  }
  @RequirePermissions("membership.update")
  @Post(":membershipId/grants")
  grant(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() dto: AppGrantDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.grant(tenantId, membershipId, dto.applicationId, actor);
  }
  @RequirePermissions("membership.update")
  @Delete(":membershipId/grants/:applicationId")
  revoke(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser) {
    return this.service.revoke(tenantId, membershipId, applicationId, actor);
  }
}

/** Canonical app-grant endpoint. RP Web/CLI have separate native client keys. */
@Controller("tenants/:tenantId/memberships/:membershipId/app-grants")
export class MembershipAppGrantsController {
  constructor(private readonly service: AppConsumersService) {}

  @RequirePermissions("membership.read")
  @Get()
  async list(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string) {
    const members = await this.service.list(tenantId);
    return members.find(m => m.membershipId === membershipId) ?? null;
  }
  @RequirePermissions("membership.update")
  @Post()
  grant(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() dto: AppGrantDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.grant(tenantId, membershipId, dto.applicationId, actor);
  }
  @RequirePermissions("membership.update")
  @Delete(":applicationId")
  revoke(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser) {
    return this.service.revoke(tenantId, membershipId, applicationId, actor);
  }

  @RequirePermissions("membership.update")
  @Post("native/:clientKey")
  grantNative(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Param("clientKey") clientKey: NativeClientKey, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.grantNative(tenantId, membershipId, clientKey, actor);
  }
  @RequirePermissions("membership.update")
  @Delete("native/:clientKey")
  revokeNative(@Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Param("clientKey") clientKey: NativeClientKey, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.revokeNative(tenantId, membershipId, clientKey, actor);
  }
}
