import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateMembershipDto } from "./dto/create-membership.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { TopUpBillingDto } from "./dto/top-up-billing.dto";
import { UpdateMembershipDto } from "./dto/update-membership.dto";
import { UpdateQuotaDto } from "./dto/update-quota.dto";
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

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing")
  getBilling(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.getBilling(tenantId);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing/transactions")
  listBillingTransactions(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listBillingTransactions(tenantId);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing/usage-records")
  listUsageRecords(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listUsageRecords(tenantId);
  }

  @RequirePermissions("billing.topup")
  @Post(":tenantId/billing/top-up")
  topUpBilling(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: TopUpBillingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.topUpBilling(tenantId, dto, user);
  }

  @RequirePermissions("tenant.read")
  @Get(":tenantId/quota")
  getQuota(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.getQuota(tenantId);
  }

  @RequirePermissions("tenant.settings.update")
  @Patch(":tenantId/quota")
  updateQuota(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateQuotaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.updateQuota(tenantId, dto, user);
  }

  @RequirePermissions("membership.read")
  @Get(":tenantId/roles")
  listRoles(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listRoles(tenantId);
  }

  @RequirePermissions("membership.read")
  @Get(":tenantId/memberships")
  listMemberships(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listMemberships(tenantId);
  }

  @RequirePermissions("membership.invite")
  @Post(":tenantId/memberships")
  createMembership(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateMembershipDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.createMembership(tenantId, dto, user);
  }

  @RequirePermissions("membership.update")
  @Patch(":tenantId/memberships/:membershipId")
  updateMembership(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateMembershipDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.updateMembership(tenantId, membershipId, dto, user);
  }

  @RequirePermissions("membership.remove")
  @Delete(":tenantId/memberships/:membershipId")
  deleteMembership(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.deleteMembership(tenantId, membershipId, user);
  }
}
