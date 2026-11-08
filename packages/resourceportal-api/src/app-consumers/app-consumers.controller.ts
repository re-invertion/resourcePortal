import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { IsUUID } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { AppConsumersService } from "./app-consumers.service";

class AppConsumerGrantDto {
  @IsUUID()
  applicationId!: string;
}

@Controller("tenants/:tenantId/app-consumers")
export class AppConsumersController {
  constructor(private readonly service: AppConsumersService) {}

  @RequirePermissions("membership.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.list(tenantId);
  }

  @RequirePermissions("membership.update")
  @Post(":membershipId/grants")
  grant(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() dto: AppConsumerGrantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.grant(tenantId, membershipId, dto.applicationId, actor);
  }

  @RequirePermissions("membership.update")
  @Delete(":membershipId/grants/:applicationId")
  revoke(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.revoke(tenantId, membershipId, applicationId, actor);
  }
}
