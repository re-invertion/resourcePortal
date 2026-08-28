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
import { UpdateMembershipDto } from "./dto/update-membership.dto";
import { mapMembership } from "./tenants.view";

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
