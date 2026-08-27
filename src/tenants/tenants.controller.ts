import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { TenantsService } from "./tenants.service";

@Controller("tenants")
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  listTenants(@CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.listTenants(user.id);
  }

  @RequirePermissions("tenant.read")
  @Get(":tenantId")
  getTenant(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.getTenant(tenantId);
  }

  @Post()
  createTenant(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    if (!user) {
      throw new UnauthorizedException("x-dev-user-id header is required");
    }

    return this.tenantsService.createTenant(dto, user);
  }
}
