import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { IdentityProviderScope, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateIdentityProviderDto } from "./dto/create-identity-provider.dto";
import { UpdateIdentityProviderDto } from "./dto/update-identity-provider.dto";

@Injectable()
export class IdentityProvidersService {
  constructor(private readonly prisma: PrismaService) {}

  async listTenantIdentityProviders(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    return this.prisma.identityProvider.findMany({
      where: { tenantId, scope: IdentityProviderScope.Tenant },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
  }

  async getTenantIdentityProvider(tenantId: string, identityProviderId: string) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: {
        id: identityProviderId,
        tenantId,
        scope: IdentityProviderScope.Tenant,
      },
    });

    if (!provider) {
      throw new NotFoundException("Identity provider not found");
    }

    return provider;
  }

  async createTenantIdentityProvider(
    tenantId: string,
    dto: CreateIdentityProviderDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const provider = await tx.identityProvider.create({
          data: {
            scope: IdentityProviderScope.Tenant,
            tenantId,
            name: dto.name,
            protocol: dto.protocol,
            zitadelIdentityProviderId: dto.zitadelIdentityProviderId,
            issuer: dto.issuer,
            metadataUrl: dto.metadataUrl,
            enabled: dto.enabled ?? true,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "identity_provider.create",
            resourceType: "IdentityProvider",
            resourceId: provider.id,
            resourceName: provider.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              scope: provider.scope,
              protocol: provider.protocol,
              enabled: provider.enabled,
              issuer: provider.issuer,
              metadataUrl: provider.metadataUrl,
              zitadelIdentityProviderId: provider.zitadelIdentityProviderId,
            },
          },
        });

        return provider;
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async updateTenantIdentityProvider(
    tenantId: string,
    identityProviderId: string,
    dto: UpdateIdentityProviderDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const current = await this.getTenantIdentityProvider(tenantId, identityProviderId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const provider = await tx.identityProvider.update({
          where: { id: current.id },
          data: {
            name: dto.name,
            protocol: dto.protocol,
            zitadelIdentityProviderId: dto.zitadelIdentityProviderId,
            issuer: dto.issuer,
            metadataUrl: dto.metadataUrl,
            enabled: dto.enabled,
            updatedBy: actor.id,
          },
        });

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "identity_provider.update",
            resourceType: "IdentityProvider",
            resourceId: provider.id,
            resourceName: provider.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              name: provider.name,
              protocol: provider.protocol,
              enabled: provider.enabled,
              issuer: provider.issuer,
              metadataUrl: provider.metadataUrl,
              zitadelIdentityProviderId: provider.zitadelIdentityProviderId,
            },
          },
        });

        return provider;
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async deleteTenantIdentityProvider(
    tenantId: string,
    identityProviderId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const provider = await this.getTenantIdentityProvider(tenantId, identityProviderId);

    await this.prisma.$transaction(async (tx) => {
      await tx.identityProvider.delete({ where: { id: provider.id } });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "identity_provider.delete",
          resourceType: "IdentityProvider",
          resourceId: provider.id,
          resourceName: provider.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { protocol: provider.protocol },
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

  private rethrowConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException("Identity provider already exists");
    }

    throw error;
  }
}
