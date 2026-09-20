import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { CreateServiceIdentityDto } from "./dto/create-service-identity.dto";
import { UpdateServiceIdentityDto } from "./dto/update-service-identity.dto";
import { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

type ServiceIdentityRecord = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: "Active" | "Suspended";
  zitadelUserId: string;
  clientId: string;
  clientSecretCiphertext: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type RoleRecord = { id: string; name: string; permissions: string[] };
type ServiceIdentityWithRoles = ServiceIdentityRecord & {
  roles: Array<{ role: RoleRecord }>;
};

@Injectable()
export class ServiceIdentitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelServiceIdentityService,
  ) {}

  async list(tenantId: string) {
    await this.ensureTenant(tenantId);
    const records = await this.prisma.serviceIdentity.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: {
        roles: {
          include: { role: true },
          orderBy: { role: { name: "asc" } },
        },
      },
    });
    return records.map((record) => this.mapWithRoles(this.asTenantRecord(record)));
  }

  async get(tenantId: string, serviceIdentityId: string) {
    return this.mapWithRoles(await this.getRecord(tenantId, serviceIdentityId));
  }

  async create(tenantId: string, dto: CreateServiceIdentityDto, actor: AuthenticatedUser) {
    const tenant = await this.ensureTenant(tenantId);
    await this.validateRoles(dto.roleIds);
    const id = randomUUID();
    const remote = await this.zitadel.create(id, dto.name, dto.description);

    try {
      await this.prisma.$transaction(async (tx) => {
        const roleIds = [...new Set(dto.roleIds)];
        await tx.serviceIdentity.create({
          data: {
            id,
            tenantId,
            name: dto.name,
            description: dto.description ?? null,
            status: "Active",
            zitadelUserId: remote.userId,
            clientId: remote.clientId,
            clientSecretCiphertext: this.encryption.encrypt(remote.clientSecret),
            createdBy: actor.id,
            updatedBy: actor.id,
            roles: {
              create: roleIds.map((roleId) => ({ roleId })),
            },
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "service_identity.create",
            resourceType: "ServiceIdentity",
            resourceId: id,
            resourceName: dto.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: { roleIds: [...new Set(dto.roleIds)], clientId: remote.clientId },
          },
        });
      });
    } catch (error) {
      await this.disableRemoteIgnoringFailure(remote.userId);
      this.rethrowConflict(error);
    }

    return {
      ...(await this.get(tenantId, id)),
      clientSecret: remote.clientSecret,
      tokenRequest: {
        grantType: "client_credentials",
        tokenEndpoint: `${this.issuerUrl()}/oauth/v2/token`,
        scopes: ["openid", `urn:zitadel:iam:org:project:id:${this.projectId()}:aud`],
      },
    };
  }

  async update(
    tenantId: string,
    serviceIdentityId: string,
    dto: UpdateServiceIdentityDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenant(tenantId);
    const current = await this.getRecord(tenantId, serviceIdentityId);
    const roleIds = dto.roleIds ? [...new Set(dto.roleIds)] : undefined;
    if (roleIds) await this.validateRoles(roleIds);

    const name = dto.name ?? current.name;
    const description = dto.description ?? current.description ?? undefined;
    if (dto.name !== undefined || dto.description !== undefined) {
      await this.zitadel.update(current.zitadelUserId, name, description);
    }
    if (dto.status && dto.status !== current.status) {
      await this.zitadel.setActive(current.zitadelUserId, dto.status === "Active");
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.serviceIdentity.updateMany({
          where: { id: serviceIdentityId, tenantId },
          data: {
            name,
            description: description ?? null,
            status: dto.status ?? current.status,
            updatedBy: actor.id,
          },
        });
        if (roleIds) {
          await tx.serviceIdentityRole.deleteMany({
            where: { serviceIdentityId },
          });
          if (roleIds.length > 0) {
            await tx.serviceIdentityRole.createMany({
              data: roleIds.map((roleId) => ({ serviceIdentityId, roleId })),
            });
          }
        }
        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "service_identity.update",
            resourceType: "ServiceIdentity",
            resourceId: serviceIdentityId,
            resourceName: name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              status: dto.status ?? current.status,
              ...(roleIds ? { roleIds } : {}),
            },
          },
        });
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
    return this.get(tenantId, serviceIdentityId);
  }

  async delete(tenantId: string, serviceIdentityId: string, actor: AuthenticatedUser) {
    const tenant = await this.ensureTenant(tenantId);
    const current = await this.getRecord(tenantId, serviceIdentityId);
    await this.zitadel.disable(current.zitadelUserId);
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceIdentity.deleteMany({
        where: { id: serviceIdentityId, tenantId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "service_identity.delete",
          resourceType: "ServiceIdentity",
          resourceId: serviceIdentityId,
          resourceName: current.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { clientId: current.clientId },
        },
      });
    });
    return { deleted: true };
  }

  private async getRecord(tenantId: string, serviceIdentityId: string) {
    const row = await this.prisma.serviceIdentity.findFirst({
      where: { id: serviceIdentityId, tenantId },
      include: {
        roles: {
          include: { role: true },
          orderBy: { role: { name: "asc" } },
        },
      },
    });
    if (!row) throw new NotFoundException("Service identity not found");
    return this.asTenantRecord(row);
  }

  private mapWithRoles(record: ServiceIdentityWithRoles) {
    const roles = record.roles.map(({ role }) => role);
    return {
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      description: record.description,
      status: record.status,
      clientId: record.clientId,
      roles,
      effectivePermissions: [...new Set(roles.flatMap((role) => role.permissions))].sort(),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private asTenantRecord(record: {
    id: string; tenantId: string | null; name: string; description: string | null;
    status: string; zitadelUserId: string; clientId: string;
    clientSecretCiphertext: string; createdBy: string; updatedBy: string;
    createdAt: Date; updatedAt: Date;
    roles: Array<{ role: RoleRecord }>;
  }): ServiceIdentityWithRoles {
    if (record.tenantId === null) {
      throw new NotFoundException("Service identity not found");
    }
    return {
      ...record,
      tenantId: record.tenantId,
      status: record.status as "Active" | "Suspended",
    };
  }

  private async validateRoles(roleIds: string[]) {
    const uniqueIds = [...new Set(roleIds)];
    const roles = await this.prisma.role.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
    if (roles.length !== uniqueIds.length) {
      throw new NotFoundException("One or more service identity roles do not exist");
    }
  }

  private async ensureTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  private issuerUrl() {
    const value = process.env.OIDC_ISSUER_URL;
    if (!value) return "";
    return value.replace(/\/$/, "");
  }

  private projectId() {
    return process.env.ZITADEL_PROJECT_ID ?? "<project-id>";
  }

  private async disableRemoteIgnoringFailure(userId: string) {
    try {
      await this.zitadel.disable(userId);
    } catch {
      // Preserve the database error; reconciliation can disable the remote account later.
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("Service identity already exists");
    }
    if (error instanceof Error && /unique constraint/i.test(error.message)) {
      throw new ConflictException("Service identity already exists");
    }
    throw error;
  }
}
