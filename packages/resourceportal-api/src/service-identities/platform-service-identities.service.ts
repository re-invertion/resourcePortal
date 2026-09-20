import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { CreatePlatformServiceIdentityDto } from "./dto/create-platform-service-identity.dto";
import { UpdatePlatformServiceIdentityDto } from "./dto/update-platform-service-identity.dto";
import { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

type PlatformServiceIdentityRecord = {
  id: string;
  tenantId: null;
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

@Injectable()
export class PlatformServiceIdentitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelServiceIdentityService,
  ) {}

  async list() {
    const records = await this.prisma.serviceIdentity.findMany({
      where: { tenantId: null },
      orderBy: { name: "asc" },
    });
    return records.map((record) => this.map(this.asPlatformRecord(record)));
  }

  async get(serviceIdentityId: string) {
    return this.map(await this.getRecord(serviceIdentityId));
  }

  async create(dto: CreatePlatformServiceIdentityDto, actor: AuthenticatedUser) {
    const id = randomUUID();
    const remote = await this.zitadel.create(id, dto.name, dto.description);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.serviceIdentity.create({
          data: {
            id,
            tenantId: null,
            name: dto.name,
            description: dto.description ?? null,
            status: "Active",
            zitadelUserId: remote.userId,
            clientId: remote.clientId,
            clientSecretCiphertext: this.encryption.encrypt(remote.clientSecret),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "service_identity.create",
            resourceType: "ServiceIdentity",
            resourceId: id,
            resourceName: dto.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: { scope: "Platform", clientId: remote.clientId },
          },
        });
      });
    } catch (error) {
      await this.disableRemoteIgnoringFailure(remote.userId);
      this.rethrowConflict(error);
    }

    return {
      ...(await this.get(id)),
      clientSecret: remote.clientSecret,
      tokenRequest: {
        grantType: "client_credentials",
        tokenEndpoint: `${this.issuerUrl()}/oauth/v2/token`,
        scopes: ["openid", `urn:zitadel:iam:org:project:id:${this.projectId()}:aud`],
      },
    };
  }

  async update(
    serviceIdentityId: string,
    dto: UpdatePlatformServiceIdentityDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.getRecord(serviceIdentityId);
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
          where: { id: serviceIdentityId, tenantId: null },
          data: {
            name,
            description: description ?? null,
            status: dto.status ?? current.status,
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "service_identity.update",
            resourceType: "ServiceIdentity",
            resourceId: serviceIdentityId,
            resourceName: name,
            result: "Success",
            correlationId: randomUUID(),
            changes: { scope: "Platform", status: dto.status ?? current.status },
          },
        });
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
    return this.get(serviceIdentityId);
  }

  async delete(serviceIdentityId: string, actor: AuthenticatedUser) {
    const current = await this.getRecord(serviceIdentityId);
    await this.zitadel.disable(current.zitadelUserId);
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceIdentity.deleteMany({
        where: { id: serviceIdentityId, tenantId: null },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "service_identity.delete",
          resourceType: "ServiceIdentity",
          resourceId: serviceIdentityId,
          resourceName: current.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { scope: "Platform", clientId: current.clientId },
        },
      });
    });
    return { deleted: true };
  }

  private async getRecord(serviceIdentityId: string) {
    const row = await this.prisma.serviceIdentity.findFirst({
      where: { id: serviceIdentityId, tenantId: null },
    });
    if (!row) throw new NotFoundException("Platform service identity not found");
    return this.asPlatformRecord(row);
  }

  private asPlatformRecord(record: {
    id: string; tenantId: string | null; name: string; description: string | null;
    status: string; zitadelUserId: string; clientId: string;
    clientSecretCiphertext: string; createdBy: string; updatedBy: string;
    createdAt: Date; updatedAt: Date;
  }): PlatformServiceIdentityRecord {
    return {
      ...record,
      tenantId: null,
      status: record.status as "Active" | "Suspended",
    };
  }

  private map(record: PlatformServiceIdentityRecord) {
    return {
      id: record.id,
      scope: "Platform" as const,
      tenantId: null,
      name: record.name,
      description: record.description,
      status: record.status,
      clientId: record.clientId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private issuerUrl() {
    return (process.env.OIDC_ISSUER_URL ?? "").replace(/\/$/, "");
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
      throw new ConflictException("Platform service identity already exists");
    }
    if (error instanceof Error && /unique constraint|duplicate key/i.test(error.message)) {
      throw new ConflictException("Platform service identity already exists");
    }
    throw error;
  }
}
