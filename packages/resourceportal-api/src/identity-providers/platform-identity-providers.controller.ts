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
import { CreateIdentityProviderDto } from "./dto/create-identity-provider.dto";
import { UpdateIdentityProviderDto } from "./dto/update-identity-provider.dto";
import { PlatformIdentityProvidersService } from "./platform-identity-providers.service";

@Controller("platform/identity-providers")
@UseGuards(PlatformAdminGuard)
export class PlatformIdentityProvidersController {
  constructor(private readonly service: PlatformIdentityProvidersService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(":identityProviderId")
  get(@Param("identityProviderId", ParseUUIDPipe) identityProviderId: string) {
    return this.service.get(identityProviderId);
  }

  @Post()
  create(@Body() dto: CreateIdentityProviderDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.service.create(dto, actor);
  }

  @Patch(":identityProviderId")
  update(
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @Body() dto: UpdateIdentityProviderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(identityProviderId, dto, actor);
  }

  @Delete(":identityProviderId")
  delete(
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(identityProviderId, actor);
  }
}
