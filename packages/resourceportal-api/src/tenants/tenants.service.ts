import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { MembershipStatus, Prisma, UserStatus } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
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
import {
  mapBillingAccount,
  mapBillingTransaction,
  mapMembership,
  mapQuota,
  mapTenantAuthPolicy,
  mapTenantGroup,
  mapTenantInvitation,
  mapUsageRecord,
} from "./tenants.view";

const TENANT_OWNER_ROLE_ID = "tenant-owner";

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  listTenants(userId: string) {
    return this.prisma.tenant.findMany({
      where: {
        memberships: {
          some: {
            userId,
            status: "Active",
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        billing: true,
        authPolicy: true,
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
                status: true,
              },
            },
            roles: {
              include: { role: true },
            },
          },
        },
      },
    });
  }

  async getTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        billing: true,
        quota: true,
        authPolicy: true,
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
                status: true,
              },
            },
            roles: {
              include: { role: true },
            },
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return {
      ...tenant,
      quota: tenant.quota ? mapQuota(tenant.quota) : null,
    };
  }

  async createTenant(dto: CreateTenantDto, actor: AuthenticatedUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: dto.name,
            displayName: dto.displayName,
            description: dto.description,
            contactEmail: dto.contactEmail.toLowerCase(),
            billing: {
              create: {
                balance: 0,
                currency: "credits",
                informationThreshold: 0,
              },
            },
            authPolicy: {
              create: {
                allowPlatformLogin: true,
                allowTenantIdentityProviders: true,
                requireTenantIdentityProvider: false,
              },
            },
            memberships: {
              create: {
                userId: actor.id,
                createdBy: actor.id,
                roles: {
                  create: {
                    roleId: TENANT_OWNER_ROLE_ID,
                  },
                },
              },
            },
            auditEntries: {
              create: {
                tenantName: dto.name,
                actor: actor.id,
                actorName: actor.displayName,
                action: "tenant.create",
                resourceType: "Tenant",
                result: "Success",
                correlationId: randomUUID(),
                changes: {
                  name: dto.name,
                  displayName: dto.displayName,
                  contactEmail: dto.contactEmail.toLowerCase(),
                },
              },
            },
          },
          include: {
            billing: true,
            authPolicy: true,
            memberships: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    displayName: true,
                    status: true,
                  },
                },
                roles: {
                  include: { role: true },
                },
              },
            },
          },
        });

        return tenant;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("Tenant name already exists");
      }

      throw error;
    }
  }

  async getAuthPolicy(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const policy = await this.prisma.tenantAuthPolicy.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });

    return mapTenantAuthPolicy(policy);
  }

  async updateAuthPolicy(
    tenantId: string,
    dto: UpdateTenantAuthPolicyDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const policy = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenantAuthPolicy.upsert({
        where: { tenantId },
        create: {
          tenantId,
          allowPlatformLogin: dto.allowPlatformLogin ?? true,
          allowTenantIdentityProviders:
            dto.allowTenantIdentityProviders ?? true,
          requireTenantIdentityProvider:
            dto.requireTenantIdentityProvider ?? false,
        },
        update: dto,
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_auth_policy.update",
          resourceType: "TenantAuthPolicy",
          resourceId: tenantId,
          result: "Success",
          correlationId: randomUUID(),
          changes: { ...dto },
        },
      });

      return updated;
    });

    return mapTenantAuthPolicy(policy);
  }

  async getBilling(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const billing = await this.prisma.billingAccount.findUnique({
      where: { tenantId },
      include: {
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        usageRecords: {
          orderBy: { periodEnd: "desc" },
          take: 20,
        },
      },
    });

    if (!billing) {
      throw new NotFoundException("Billing account not found");
    }

    return mapBillingAccount(billing);
  }

  async listBillingTransactions(tenantId: string) {
    const billing = await this.findBillingOrThrow(tenantId);
    const transactions = await this.prisma.billingTransaction.findMany({
      where: { billingAccountId: billing.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return transactions.map(mapBillingTransaction);
  }

  async listUsageRecords(tenantId: string) {
    const billing = await this.findBillingOrThrow(tenantId);
    const usageRecords = await this.prisma.usageRecord.findMany({
      where: { billingAccountId: billing.id },
      orderBy: { periodEnd: "desc" },
      take: 200,
    });

    return usageRecords.map(mapUsageRecord);
  }

  async topUpBilling(
    tenantId: string,
    dto: TopUpBillingDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const billing = await tx.billingAccount.findUnique({
        where: { tenantId },
      });

      if (!billing) {
        throw new NotFoundException("Billing account not found");
      }

      const balanceBefore = billing.balance;
      const balanceAfter = balanceBefore.plus(amount);
      const updatedBilling = await tx.billingAccount.update({
        where: { id: billing.id },
        data: {
          balance: balanceAfter,
        },
      });
      const transaction = await tx.billingTransaction.create({
        data: {
          billingAccountId: billing.id,
          type: "TopUp",
          amount,
          balanceBefore,
          balanceAfter,
          status: "Succeeded",
          reference: dto.reference,
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "billing.topup",
          resourceType: "BillingAccount",
          resourceId: billing.id,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            amount: amount.toString(),
            balanceBefore: balanceBefore.toString(),
            balanceAfter: balanceAfter.toString(),
            reference: dto.reference,
          },
        },
      });

      return { billing: updatedBilling, transaction };
    });

    return {
      billing: mapBillingAccount(result.billing),
      transaction: mapBillingTransaction(result.transaction),
    };
  }

  async getQuota(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const quota = await this.prisma.quota.findUnique({
      where: { tenantId },
    });

    return quota ? mapQuota(quota) : null;
  }

  async updateQuota(
    tenantId: string,
    dto: UpdateQuotaDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const existing = await this.prisma.quota.findUnique({
      where: { tenantId },
    });

    if (!existing) {
      this.assertQuotaCreatePayload(dto);
    }

    const quota = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.quota.upsert({
        where: { tenantId },
        create: {
          tenantId,
          cpu: dto.cpu!,
          memoryBytes: BigInt(dto.memoryBytes!),
          gpu: dto.gpu!,
          storageBytes: BigInt(dto.storageBytes!),
          maxSingleApps: dto.maxSingleApps!,
          maxVolumes: dto.maxVolumes!,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        update: {
          cpu: dto.cpu,
          memoryBytes:
            dto.memoryBytes === undefined ? undefined : BigInt(dto.memoryBytes),
          gpu: dto.gpu,
          storageBytes:
            dto.storageBytes === undefined ? undefined : BigInt(dto.storageBytes),
          maxSingleApps: dto.maxSingleApps,
          maxVolumes: dto.maxVolumes,
          updatedBy: actor.id,
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: existing ? "quota.update" : "quota.create",
          resourceType: "Quota",
          resourceId: updated.id,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            previousQuota: existing
              ? {
                  cpu: existing.cpu.toString(),
                  memoryBytes: existing.memoryBytes.toString(),
                  gpu: existing.gpu,
                  storageBytes: existing.storageBytes.toString(),
                  maxSingleApps: existing.maxSingleApps,
                  maxVolumes: existing.maxVolumes,
                }
              : null,
            quota: mapQuota(updated),
          },
        },
      });

      return updated;
    });

    return mapQuota(quota);
  }

  async listRoles(tenantId: string) {
    await this.ensureTenantExists(tenantId);

    return this.prisma.role.findMany({
      orderBy: { name: "asc" },
    });
  }

  async listMemberships(tenantId: string) {
    await this.ensureTenantExists(tenantId);

    const memberships = await this.prisma.tenantMembership.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      include: this.membershipIncludes(),
    });

    return memberships.map(mapMembership);
  }

  async listInvitations(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const invitations = await this.prisma.tenantInvitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });

    return invitations.map(mapTenantInvitation);
  }

  async createInvitation(
    tenantId: string,
    dto: CreateTenantInvitationDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    await this.ensureRolesExist(dto.roleIds);
    const email = normalizeEmail(dto.email);
    const existingMembership = await this.prisma.tenantMembership.findFirst({
      where: {
        tenantId,
        user: { email },
      },
    });

    if (existingMembership?.status === MembershipStatus.Active) {
      throw new ConflictException("AlreadyMember");
    }

    if (existingMembership) {
      throw new ConflictException("MembershipAlreadyExists");
    }

    const token = randomToken();
    try {
      const invitation = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tenantInvitation.create({
          data: {
            tenantId,
            email,
            roleIds: dto.roleIds,
            tokenHash: hashToken(token),
            expiresAt: invitationExpiry(),
            lastSentAt: new Date(),
            createdBy: actor.id,
          },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "tenant_invitation.create",
            resourceType: "TenantInvitation",
            resourceId: created.id,
            resourceName: email,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              email,
              roleIds: dto.roleIds,
              expiresAt: created.expiresAt,
            },
          },
        });

        return created;
      });

      return {
        ...mapTenantInvitation(invitation),
        token,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("TenantInvitation already exists");
      }

      throw error;
    }
  }

  async resendInvitation(
    tenantId: string,
    invitationId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const existing = await this.findInvitationOrThrow(tenantId, invitationId);
    const token = randomToken();

    const invitation = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenantInvitation.update({
        where: { id: existing.id },
        data: {
          tokenHash: hashToken(token),
          expiresAt: invitationExpiry(),
          lastSentAt: new Date(),
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_invitation.resend",
          resourceType: "TenantInvitation",
          resourceId: updated.id,
          resourceName: updated.email,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            email: updated.email,
            roleIds: updated.roleIds,
            expiresAt: updated.expiresAt,
          },
        },
      });

      return updated;
    });

    return {
      ...mapTenantInvitation(invitation),
      token,
    };
  }

  async deleteInvitation(
    tenantId: string,
    invitationId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const existing = await this.findInvitationOrThrow(tenantId, invitationId);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantInvitation.delete({
        where: { id: existing.id },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_invitation.cancel",
          resourceType: "TenantInvitation",
          resourceId: existing.id,
          resourceName: existing.email,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            email: existing.email,
            roleIds: existing.roleIds,
          },
        },
      });
    });

    return { deleted: true };
  }

  async acceptInvitation(
    dto: AcceptTenantInvitationDto,
    actor: AuthenticatedUser,
  ) {
    if (actor.status !== UserStatus.Active) {
      throw new BadRequestException("Active user is required");
    }

    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      include: { tenant: { select: { id: true, name: true } } },
    });

    if (!invitation) {
      throw new NotFoundException("TenantInvitation not found");
    }

    if (invitation.expiresAt <= new Date()) {
      throw new BadRequestException("TenantInvitationExpired");
    }

    if (normalizeEmail(actor.email) !== invitation.email) {
      throw new ForbiddenException("InvitationEmailMismatch");
    }

    await this.ensureRolesExist(invitation.roleIds);

    const membership = await this.prisma.$transaction(async (tx) => {
      const existingMembership = await tx.tenantMembership.findUnique({
        where: {
          userId_tenantId: {
            userId: actor.id,
            tenantId: invitation.tenantId,
          },
        },
      });

      if (existingMembership) {
        throw new ConflictException("MembershipAlreadyExists");
      }

      const created = await tx.tenantMembership.create({
        data: {
          tenantId: invitation.tenantId,
          userId: actor.id,
          status: MembershipStatus.Active,
          createdBy: invitation.createdBy,
          roles: {
            create: invitation.roleIds.map((roleId) => ({ roleId })),
          },
        },
        include: this.membershipIncludes(),
      });

      await tx.tenantInvitation.delete({
        where: { id: invitation.id },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId: invitation.tenantId,
          tenantName: invitation.tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_invitation.accept",
          resourceType: "TenantMembership",
          resourceId: created.id,
          resourceName: actor.email,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            invitationId: invitation.id,
            email: invitation.email,
            roleIds: invitation.roleIds,
          },
        },
      });

      return created;
    });

    return mapMembership(membership);
  }

  async listGroups(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const groups = await this.prisma.tenantGroup.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: this.groupIncludes(),
    });

    return groups.map(mapTenantGroup);
  }

  async createGroup(
    tenantId: string,
    dto: CreateTenantGroupDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);

    try {
      const group = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tenantGroup.create({
          data: {
            tenantId,
            name: dto.name,
            description: dto.description,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          include: this.groupIncludes(),
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "tenant_group.create",
            resourceType: "TenantGroup",
            resourceId: created.id,
            resourceName: created.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: { ...dto },
          },
        });

        return created;
      });

      return mapTenantGroup(group);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("TenantGroup name already exists");
      }

      throw error;
    }
  }

  async updateGroup(
    tenantId: string,
    groupId: string,
    dto: UpdateTenantGroupDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    await this.findGroupOrThrow(tenantId, groupId);

    const group = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenantGroup.update({
        where: { id: groupId },
        data: {
          ...dto,
          updatedBy: actor.id,
        },
        include: this.groupIncludes(),
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_group.update",
          resourceType: "TenantGroup",
          resourceId: updated.id,
          resourceName: updated.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { ...dto },
        },
      });

      return updated;
    });

    return mapTenantGroup(group);
  }

  async deleteGroup(
    tenantId: string,
    groupId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const group = await this.findGroupOrThrow(tenantId, groupId);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantGroup.delete({ where: { id: groupId } });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_group.delete",
          resourceType: "TenantGroup",
          resourceId: group.id,
          resourceName: group.name,
          result: "Success",
          correlationId: randomUUID(),
        },
      });
    });

    return { deleted: true };
  }

  async addGroupMember(
    tenantId: string,
    groupId: string,
    dto: AddTenantGroupMemberDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const group = await this.findGroupOrThrow(tenantId, groupId);
    await this.findMembershipOrThrow(tenantId, dto.membershipId);

    try {
      const member = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tenantGroupMember.create({
          data: {
            tenantGroupId: groupId,
            membershipId: dto.membershipId,
          },
          include: {
            membership: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    displayName: true,
                    status: true,
                  },
                },
              },
            },
          },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "tenant_group.member.add",
            resourceType: "TenantGroup",
            resourceId: group.id,
            resourceName: group.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              membershipId: dto.membershipId,
            },
          },
        });

        return created;
      });

      return {
        id: member.id,
        tenantGroupId: member.tenantGroupId,
        membershipId: member.membershipId,
        source: member.source,
        createdAt: member.createdAt,
        membership: {
          id: member.membership.id,
          userId: member.membership.userId,
          status: member.membership.status,
          user: member.membership.user,
        },
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("TenantGroupMember already exists");
      }

      throw error;
    }
  }

  async removeGroupMember(
    tenantId: string,
    groupId: string,
    membershipId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const group = await this.findGroupOrThrow(tenantId, groupId);
    await this.findMembershipOrThrow(tenantId, membershipId);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantGroupMember.delete({
        where: {
          tenantGroupId_membershipId: {
            tenantGroupId: groupId,
            membershipId,
          },
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_group.member.remove",
          resourceType: "TenantGroup",
          resourceId: group.id,
          resourceName: group.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            membershipId,
          },
        },
      });
    });

    return { deleted: true };
  }

  async assignGroupRole(
    tenantId: string,
    groupId: string,
    dto: AssignTenantGroupRoleDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const group = await this.findGroupOrThrow(tenantId, groupId);
    await this.ensureRolesExist([dto.roleId]);

    try {
      const role = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tenantGroupRole.create({
          data: {
            tenantGroupId: groupId,
            roleId: dto.roleId,
          },
          include: { role: true },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "tenant_group.role.assign",
            resourceType: "TenantGroup",
            resourceId: group.id,
            resourceName: group.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              roleId: dto.roleId,
            },
          },
        });

        return created;
      });

      return {
        tenantGroupId: role.tenantGroupId,
        role: {
          id: role.role.id,
          name: role.role.name,
          permissions: role.role.permissions,
        },
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("TenantGroupRole already exists");
      }

      throw error;
    }
  }

  async removeGroupRole(
    tenantId: string,
    groupId: string,
    roleId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const group = await this.findGroupOrThrow(tenantId, groupId);

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantGroupRole.delete({
        where: {
          tenantGroupId_roleId: {
            tenantGroupId: groupId,
            roleId,
          },
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant_group.role.remove",
          resourceType: "TenantGroup",
          resourceId: group.id,
          resourceName: group.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            roleId,
          },
        },
      });
    });

    return { deleted: true };
  }

  async createMembership(
    tenantId: string,
    dto: CreateMembershipDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    await this.ensureUserExists(dto.userId);
    await this.ensureRolesExist(dto.roleIds);

    try {
      const membership = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tenantMembership.create({
          data: {
            tenantId,
            userId: dto.userId,
            status: MembershipStatus.Active,
            createdBy: actor.id,
            roles: {
              create: dto.roleIds.map((roleId) => ({ roleId })),
            },
          },
          include: this.membershipIncludes(),
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "membership.create",
            resourceType: "TenantMembership",
            resourceId: created.id,
            resourceName: created.user.email,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              userId: dto.userId,
              roleIds: dto.roleIds,
            },
          },
        });

        return created;
      });

      return mapMembership(membership);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("TenantMembership already exists");
      }

      throw error;
    }
  }

  async updateMembership(
    tenantId: string,
    membershipId: string,
    dto: UpdateMembershipDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const existing = await this.findMembershipOrThrow(tenantId, membershipId);

    if (dto.roleIds !== undefined) {
      await this.ensureRolesExist(dto.roleIds);
    }

    await this.assertLastOwnerIsPreserved(tenantId, existing, dto);

    const membership = await this.prisma.$transaction(async (tx) => {
      if (dto.roleIds !== undefined) {
        await tx.membershipRole.deleteMany({
          where: { membershipId },
        });

        await tx.membershipRole.createMany({
          data: dto.roleIds.map((roleId) => ({ membershipId, roleId })),
        });
      }

      const updated = await tx.tenantMembership.update({
        where: { id: membershipId },
        data: {
          status: dto.status,
        },
        include: this.membershipIncludes(),
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "membership.update",
          resourceType: "TenantMembership",
          resourceId: updated.id,
          resourceName: updated.user.email,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            previousStatus: existing.status,
            status: dto.status,
            previousRoleIds: existing.roles.map(({ role }) => role.id),
            roleIds: dto.roleIds,
          },
        },
      });

      return updated;
    });

    return mapMembership(membership);
  }

  async deleteMembership(
    tenantId: string,
    membershipId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const existing = await this.findMembershipOrThrow(tenantId, membershipId);

    await this.assertLastOwnerIsPreserved(tenantId, existing, {
      status: MembershipStatus.Suspended,
      roleIds: [],
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantMembership.delete({
        where: { id: membershipId },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "membership.delete",
          resourceType: "TenantMembership",
          resourceId: membershipId,
          resourceName: existing.user.email,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            userId: existing.userId,
            roleIds: existing.roles.map(({ role }) => role.id),
          },
        },
      });
    });

    return { deleted: true };
  }

  private async ensureTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return tenant;
  }

  private async ensureUserExists(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }
  }

  private async findBillingOrThrow(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const billing = await this.prisma.billingAccount.findUnique({
      where: { tenantId },
      select: { id: true },
    });

    if (!billing) {
      throw new NotFoundException("Billing account not found");
    }

    return billing;
  }

  private assertQuotaCreatePayload(dto: UpdateQuotaDto) {
    const missing = [
      ["cpu", dto.cpu],
      ["memoryBytes", dto.memoryBytes],
      ["gpu", dto.gpu],
      ["storageBytes", dto.storageBytes],
      ["maxSingleApps", dto.maxSingleApps],
      ["maxVolumes", dto.maxVolumes],
    ]
      .filter(([, value]) => value === undefined)
      .map(([field]) => field);

    if (missing.length > 0) {
      throw new BadRequestException({
        message: "Quota does not exist; all quota fields are required",
        missing,
      });
    }
  }

  private async ensureRolesExist(roleIds: string[]) {
    if (new Set(roleIds).size !== roleIds.length) {
      throw new BadRequestException("Role ids must be unique");
    }

    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true },
    });
    const foundRoleIds = new Set(roles.map((role) => role.id));
    const missingRoleIds = roleIds.filter((roleId) => !foundRoleIds.has(roleId));

    if (missingRoleIds.length > 0) {
      throw new NotFoundException({
        message: "Role not found",
        roleIds: missingRoleIds,
      });
    }
  }

  private async findMembershipOrThrow(tenantId: string, membershipId: string) {
    const membership = await this.prisma.tenantMembership.findFirst({
      where: { id: membershipId, tenantId },
      include: this.membershipIncludes(),
    });

    if (!membership) {
      throw new NotFoundException("TenantMembership not found");
    }

    return membership;
  }

  private async findInvitationOrThrow(tenantId: string, invitationId: string) {
    const invitation = await this.prisma.tenantInvitation.findFirst({
      where: { id: invitationId, tenantId },
    });

    if (!invitation) {
      throw new NotFoundException("TenantInvitation not found");
    }

    return invitation;
  }

  private async findGroupOrThrow(tenantId: string, groupId: string) {
    const group = await this.prisma.tenantGroup.findFirst({
      where: { id: groupId, tenantId },
      include: this.groupIncludes(),
    });

    if (!group) {
      throw new NotFoundException("TenantGroup not found");
    }

    return group;
  }

  private async assertLastOwnerIsPreserved(
    tenantId: string,
    membership: Awaited<ReturnType<TenantsService["findMembershipOrThrow"]>>,
    dto: Pick<UpdateMembershipDto, "roleIds" | "status">,
  ) {
    const currentlyOwner = membership.roles.some(
      ({ role }) => role.id === TENANT_OWNER_ROLE_ID,
    );

    if (!currentlyOwner) {
      return;
    }

    const nextOwner =
      dto.roleIds === undefined
        ? currentlyOwner
        : dto.roleIds.includes(TENANT_OWNER_ROLE_ID);
    const nextActive =
      dto.status === undefined
        ? membership.status === MembershipStatus.Active
        : dto.status === MembershipStatus.Active;

    if (nextOwner && nextActive) {
      return;
    }

    const otherOwnerCount = await this.prisma.tenantMembership.count({
      where: {
        tenantId,
        id: { not: membership.id },
        status: MembershipStatus.Active,
        roles: {
          some: {
            roleId: TENANT_OWNER_ROLE_ID,
          },
        },
      },
    });

    if (otherOwnerCount === 0) {
      throw new ConflictException("TenantLastOwner");
    }
  }

  private membershipIncludes() {
    return {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
        },
      },
      roles: {
        include: { role: true },
        orderBy: { roleId: "asc" as const },
      },
      groupMemberships: {
        include: {
          group: {
            include: {
              roles: {
                include: { role: true },
                orderBy: { roleId: "asc" as const },
              },
            },
          },
        },
        orderBy: { tenantGroupId: "asc" as const },
      },
    };
  }

  private groupIncludes() {
    return {
      members: {
        include: {
          membership: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  displayName: true,
                  status: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" as const },
      },
      roles: {
        include: { role: true },
        orderBy: { roleId: "asc" as const },
      },
    };
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function invitationExpiry() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  return expiresAt;
}