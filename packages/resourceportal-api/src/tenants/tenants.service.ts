import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { MembershipStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMembershipDto } from "./dto/create-membership.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { TopUpBillingDto } from "./dto/top-up-billing.dto";
import { UpdateMembershipDto } from "./dto/update-membership.dto";
import { UpdateQuotaDto } from "./dto/update-quota.dto";
import {
  mapBillingAccount,
  mapBillingTransaction,
  mapMembership,
  mapQuota,
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

    return tenant;
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
    };
  }
}
