import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Optional } from "@nestjs/common";
import { NativeLoginModeService } from "../auth/native-login-mode.service";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import { CreateIdentityProviderDto } from "./dto/create-identity-provider.dto";
import { UpdateIdentityProviderDto } from "./dto/update-identity-provider.dto";
import { PlatformIdentityProvidersService } from "./platform-identity-providers.service";
import { FederationRetirementService } from "./federation-retirement.service";

@Controller("platform/identity-providers")
@UseGuards(PlatformAdminGuard)
export class PlatformIdentityProvidersController {
  constructor(
    private readonly service: PlatformIdentityProvidersService,
    private readonly retirement: FederationRetirementService,
    private readonly config: ConfigService,
    @Optional() private readonly nativeMode?: NativeLoginModeService,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get("retirement-preflight")
  retirementPreflight() {
    return this.retirement.preflight();
  }

  @Get(":identityProviderId")
  get(@Param("identityProviderId", ParseUUIDPipe) identityProviderId: string) {
    return this.service.get(identityProviderId);
  }

  @Post()
  async create(@Body() dto: CreateIdentityProviderDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.assertFederationAvailable();
    return this.service.create(dto, actor);
  }

  @Patch(":identityProviderId")
  async update(
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @Body() dto: UpdateIdentityProviderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.assertFederationAvailable();
    return this.service.update(identityProviderId, dto, actor);
  }

  @Delete(":identityProviderId")
  delete(
    @Param("identityProviderId", ParseUUIDPipe) identityProviderId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.delete(identityProviderId, actor);
  }

  private async assertFederationAvailable() {
    const nativeOnly = this.nativeMode
      ? await this.nativeMode.isNativeOnly()
      : this.config.get<string>("RP_NATIVE_LOGIN_ONLY") === "true";
    if (nativeOnly) {
      throw new GoneException("Incoming identity provider configuration has been retired");
    }
  }

}
