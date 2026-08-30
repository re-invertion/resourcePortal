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
import { CreatePlatformServiceIdentityDto } from "./dto/create-platform-service-identity.dto";
import { UpdatePlatformServiceIdentityDto } from "./dto/update-platform-service-identity.dto";
import { PlatformServiceIdentitiesService } from "./platform-service-identities.service";
import { ServiceIdentityCredentialsService } from "./service-identity-credentials.service";

@Controller("platform/service-identities")
@UseGuards(PlatformAdminGuard)
export class PlatformServiceIdentitiesController {
  constructor(
    private readonly service: PlatformServiceIdentitiesService,
    private readonly credentials: ServiceIdentityCredentialsService,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(":serviceIdentityId")
  get(@Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string) {
    return this.service.get(serviceIdentityId);
  }

  @Post()
  create(
    @Body() dto: CreatePlatformServiceIdentityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.create(dto, actor);
  }

  @Patch(":serviceIdentityId")
  update(
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
    @Body() dto: UpdatePlatformServiceIdentityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(serviceIdentityId, dto, actor);
  }

  @Post(":serviceIdentityId/rotate-credentials")
  rotateCredentials(
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.credentials.rotatePlatform(serviceIdentityId, actor);
  }

  @Delete(":serviceIdentityId")
  delete(
    @Param("serviceIdentityId", ParseUUIDPipe) serviceIdentityId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(serviceIdentityId, actor);
  }
}
