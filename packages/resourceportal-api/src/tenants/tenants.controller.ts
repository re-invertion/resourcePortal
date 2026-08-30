import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { Authenticated } from "../auth/authenticated.decorator";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import {
  BillingHistoryQueryDto,
  RedeemVoucherDto,
  UsageHistoryQueryDto,
} from "../billing/billing.dto";
import { BillingReadService } from "../billing/billing-read.service";
import { BillingService } from "../billing/billing.service";
import { AcceptTenantInvitationDto } from "./dto/accept-tenant-invitation.dto";
import { AddTenantGroupMemberDto } from "./dto/add-tenant-group-member.dto";
import { AssignTenantGroupRoleDto } from "./dto/assign-tenant-group-role.dto";
import { CreateMembershipDto } from "./dto/create-membership.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { CreateTenantGroupDto } from "./dto/create-tenant-group.dto";
import { CreateTenantInvitationDto } from "./dto/create-tenant-invitation.dto";
import { TopUpBillingDto } from "./dto/top-up-billing.dto";
import { UpdateMembershipDto } from "./dto/update-membership.dto";
import { UpdateQuotaDto } from "./dto/update-quota.dto";
import { UpdateTenantAuthPolicyDto } from "./dto/update-tenant-auth-policy.dto";
import { UpdateTenantGroupDto } from "./dto/update-tenant-group.dto";
import { TenantsService } from "./tenants.service";

@Controller("tenants")
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly billingService: BillingService,
    private readonly billingReadService: BillingReadService,
  ) {}

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
      throw new UnauthorizedException("Authenticated user is required");
    }

    return this.tenantsService.createTenant(dto, user);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing")
  getBilling(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.billingService.getAccount(tenantId);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing/transactions")
  listBillingTransactions(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query() query: BillingHistoryQueryDto,
  ) {
    return this.billingReadService.listTransactions(tenantId, query);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing/usage-records")
  listUsageRecords(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query() query: UsageHistoryQueryDto,
  ) {
    return this.billingReadService.listUsageRecords(tenantId, query);
  }

  @RequirePermissions("billing.read")
  @Get(":tenantId/billing/usage-summary")
  usageSummary(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query() query: UsageHistoryQueryDto,
  ) {
    return this.billingReadService.usageSummary(tenantId, query);
  }

  @RequirePermissions("billing.topup")
  @Post(":tenantId/billing/vouchers/redeem")
  redeemVoucher(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: RedeemVoucherDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billingService.redeemVoucher(tenantId, dto.code, user);
  }

  @RequirePermissions("billing.topup")
  @Post(":tenantId/billing/top-up")
  topUpBilling(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: TopUpBillingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billingService.topUp(tenantId, dto.amount, dto.reference, user);
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

  @RequirePermissions("tenant_auth_policy.read")
  @Get(":tenantId/auth-policy")
  getAuthPolicy(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.getAuthPolicy(tenantId);
  }

  @RequirePermissions("tenant_auth_policy.update")
  @Patch(":tenantId/auth-policy")
  updateAuthPolicy(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateTenantAuthPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.updateAuthPolicy(tenantId, dto, user);
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

  @RequirePermissions("membership.read")
  @Get(":tenantId/invitations")
  listInvitations(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listInvitations(tenantId);
  }

  @RequirePermissions("membership.invite")
  @Post(":tenantId/invitations")
  createInvitation(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateTenantInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.createInvitation(tenantId, dto, user);
  }

  @RequirePermissions("membership.invite")
  @Post(":tenantId/invitations/:invitationId/resend")
  resendInvitation(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.resendInvitation(tenantId, invitationId, user);
  }

  @RequirePermissions("membership.remove")
  @Delete(":tenantId/invitations/:invitationId")
  deleteInvitation(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.deleteInvitation(tenantId, invitationId, user);
  }

  @RequirePermissions("group.read")
  @Get(":tenantId/groups")
  listGroups(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.listGroups(tenantId);
  }

  @RequirePermissions("group.create")
  @Post(":tenantId/groups")
  createGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateTenantGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.createGroup(tenantId, dto, user);
  }

  @RequirePermissions("group.update")
  @Patch(":tenantId/groups/:groupId")
  updateGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: UpdateTenantGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.updateGroup(tenantId, groupId, dto, user);
  }

  @RequirePermissions("group.delete")
  @Delete(":tenantId/groups/:groupId")
  deleteGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.deleteGroup(tenantId, groupId, user);
  }

  @RequirePermissions("group.member.manage")
  @Post(":tenantId/groups/:groupId/members")
  addGroupMember(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: AddTenantGroupMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.addGroupMember(tenantId, groupId, dto, user);
  }

  @RequirePermissions("group.member.manage")
  @Delete(":tenantId/groups/:groupId/members/:membershipId")
  removeGroupMember(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.removeGroupMember(
      tenantId,
      groupId,
      membershipId,
      user,
    );
  }

  @RequirePermissions("group.role.manage")
  @Post(":tenantId/groups/:groupId/roles")
  assignGroupRole(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: AssignTenantGroupRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.assignGroupRole(tenantId, groupId, dto, user);
  }

  @RequirePermissions("group.role.manage")
  @Delete(":tenantId/groups/:groupId/roles/:roleId")
  removeGroupRole(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("roleId") roleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.removeGroupRole(tenantId, groupId, roleId, user);
  }
}

@Controller("invitations")
export class TenantInvitationsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Authenticated()
  @Post("accept")
  acceptInvitation(
    @Body() dto: AcceptTenantInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.acceptInvitation(dto, user);
  }
}
