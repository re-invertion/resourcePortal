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

@Injectable()
export class ServiceIdentitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelServiceIdentityService,
  ) {}

  async list(tenantId: string) {
    await this.ensureTenant(tenantId);
    const records = await this.prisma.$queryRaw<ServiceIdentityRecord[]>`
      SELECT * FROM "ServiceIdentity"
      WHERE "tenantId" = CAST(${tenantId} AS uuid)
      ORDER BY "name" ASC
    `;
    return Promise.all(records.map((record) => this.mapWithRoles(record)));
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
        await tx.$executeRaw`
          INSERT INTO "ServiceIdentity" (
            "id", "tenantId", "name", "description", "status", "zitadelUserId",
            "clientId", "clientSecretCiphertext", "createdBy", "updatedBy"
          ) VALUES (
            CAST(${id} AS uuid), CAST(${tenantId} AS uuid), ${dto.name}, ${dto.description ?? null},
            'Active', ${remote.userId}, ${remote.clientId}, ${this.encryption.encrypt(remote.clientSecret)},
            CAST(${actor.id} AS uuid), CAST(${actor.id} AS uuid)
          )
        `;
        for (const roleId of [...new Set(dto.roleIds)]) {
          await tx.$executeRaw`
            INSERT INTO "ServiceIdentityRole" ("serviceIdentityId", "roleId")
            VALUES (CAST(${id} AS uuid), ${roleId})
          `;
        }
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
        await tx.$executeRaw`
          UPDATE "ServiceIdentity"
          SET "name" = ${name},
              "description" = ${description ?? null},
              "status" = ${dto.status ?? current.status},
              "updatedBy" = CAST(${actor.id} AS uuid),
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${serviceIdentityId} AS uuid) AND "tenantId" = CAST(${tenantId} AS uuid)
        `;
        if (roleIds) {
          await tx.$executeRaw`
            DELETE FROM "ServiceIdentityRole" WHERE "serviceIdentityId" = CAST(${serviceIdentityId} AS uuid)
          `;
          for (const roleId of roleIds) {
            await tx.$executeRaw`
              INSERT INTO "ServiceIdentityRole" ("serviceIdentityId", "roleId")
              VALUES (CAST(${serviceIdentityId} AS uuid), ${roleId})
            `;
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
      await tx.$executeRaw`
        DELETE FROM "ServiceIdentity"
        WHERE "id" = CAST(${serviceIdentityId} AS uuid) AND "tenantId" = CAST(${tenantId} AS uuid)
      `;
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
    const rows = await this.prisma.$queryRaw<ServiceIdentityRecord[]>`
      SELECT * FROM "ServiceIdentity"
      WHERE "id" = CAST(${serviceIdentityId} AS uuid) AND "tenantId" = CAST(${tenantId} AS uuid)
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException("Service identity not found");
    return rows[0];
  }

  private async roles(serviceIdentityId: string) {
    return this.prisma.$queryRaw<RoleRecord[]>`
      SELECT r."id", r."name", r."permissions"
      FROM "Role" r
      INNER JOIN "ServiceIdentityRole" sir ON sir."roleId" = r."id"
      WHERE sir."serviceIdentityId" = CAST(${serviceIdentityId} AS uuid)
      ORDER BY r."name" ASC
    `;
  }

  private async mapWithRoles(record: ServiceIdentityRecord) {
    const roles = await this.roles(record.id);
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
