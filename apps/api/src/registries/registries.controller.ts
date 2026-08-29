import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateRegistryDto } from "./dto/create-registry.dto";
import { UpdateRegistryDto } from "./dto/update-registry.dto";
import { RegistriesService } from "./registries.service";

@Controller("tenants/:tenantId/registries")
export class RegistriesController {
  constructor(private readonly registriesService: RegistriesService) {}

  @RequirePermissions("registry.read")
  @Get()
  listRegistries(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.registriesService.listRegistries(tenantId);
  }

  @RequirePermissions("registry.create")
  @Post()
  createRegistry(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateRegistryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.registriesService.createRegistry(tenantId, dto, user);
  }

  @RequirePermissions("registry.read")
  @Get(":registryId")
  getRegistry(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("registryId", ParseUUIDPipe) registryId: string,
  ) {
    return this.registriesService.getRegistry(tenantId, registryId);
  }

  @RequirePermissions("registry.update")
  @Patch(":registryId")
  updateRegistry(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("registryId", ParseUUIDPipe) registryId: string,
    @Body() dto: UpdateRegistryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.registriesService.updateRegistry(
      tenantId,
      registryId,
      dto,
      user,
    );
  }

  @RequirePermissions("registry.delete")
  @Delete(":registryId")
  deleteRegistry(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("registryId", ParseUUIDPipe) registryId: string,
  ) {
    return this.registriesService.deleteRegistry(tenantId, registryId);
  }

  @RequirePermissions("registry.validate")
  @Post(":registryId/validate")
  validateRegistry(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("registryId", ParseUUIDPipe) registryId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.registriesService.validateRegistry(tenantId, registryId, user);
  }
}
