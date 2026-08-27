import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";

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
}
