import {
  Body,
  Controller,
  Delete,
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
import { CreateOAuthApplicationDto } from "./dto/create-oauth-application.dto";
import { UpdateOAuthApplicationDto } from "./dto/update-oauth-application.dto";
import { OAuthApplicationCredentialsService } from "./oauth-application-credentials.service";
import { PlatformOAuthApplicationsService } from "./platform-oauth-applications.service";

@Controller("platform/oauth-applications")
@UseGuards(PlatformAdminGuard)
export class PlatformOAuthApplicationsController {
  constructor(
    private readonly service: PlatformOAuthApplicationsService,
    private readonly credentials: OAuthApplicationCredentialsService,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(":applicationId")
  get(@Param("applicationId", ParseUUIDPipe) applicationId: string) {
    return this.service.get(applicationId);
  }

  @Post()
  create(@Body() dto: CreateOAuthApplicationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.create(dto, actor);
  }

  @Patch(":applicationId")
  update(
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @Body() dto: UpdateOAuthApplicationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(applicationId, dto, actor);
  }

  @Post(":applicationId/rotate-credentials")
  rotateCredentials(
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.credentials.rotatePlatform(applicationId, actor);
  }

  @Delete(":applicationId")
  delete(
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(applicationId, actor);
  }
}
