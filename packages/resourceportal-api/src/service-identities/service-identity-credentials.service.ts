import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

type ServiceIdentityCredentialRecord = {
  id: string;
  tenantId: string | null;
  name: string;
  zitadelUserId: string;
  clientId: string;
};

@Injectable()
export class ServiceIdentityCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelServiceIdentityService,
  ) {}

  async rotateTenant(
    tenantId: string,
    serviceIdentityId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    const identity = await this.getTenantRecord(tenantId, serviceIdentityId);
    return this.rotate(identity, actor, tenantId, tenant.name);
  }

  async rotatePlatform(serviceIdentityId: string, actor: AuthenticatedUser) {
    const identity = await this.getPlatformRecord(serviceIdentityId);
    return this.rotate(identity, actor, null, "platform");
  }

  private async rotate(
    identity: ServiceIdentityCredentialRecord,
    actor: AuthenticatedUser,
    tenantId: string | null,
    tenantName: string,
  ) {
    const clientSecret = await this.zitadel.rotateSecret(identity.zitadelUserId);

    try {
      await this.prisma.$executeRaw`
        UPDATE "ServiceIdentity"
        SET "clientSecretCiphertext" = ${this.encryption.encrypt(clientSecret)},
            "updatedBy" = CAST(${actor.id} AS uuid),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${identity.id} AS uuid)
      `;
    } catch {
      return {
        id: identity.id,
        clientId: identity.clientId,
        clientSecret,
        persistenceStatus: "Failed" as const,
        auditStatus: "Skipped" as const,
        warning:
          "ZITADEL rotated the client secret, but the new credential was not persisted in Resource Portal. Save this secret now and retry rotation after local persistence is restored.",
      };
    }

    const auditStatus = await this.writeRotationAudit(
      identity,
      actor,
      tenantId,
      tenantName,
    );

    return {
      id: identity.id,
      clientId: identity.clientId,
      clientSecret,
      persistenceStatus: "Persisted" as const,
      auditStatus,
    };
  }

  private async writeRotationAudit(
    identity: ServiceIdentityCredentialRecord,
    actor: AuthenticatedUser,
    tenantId: string | null,
    tenantName: string,
  ) {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          tenantId,
          tenantName,
          actor: actor.id,
          actorName: actor.displayName,
          action: "service_identity.credential.rotate",
          resourceType: "ServiceIdentity",
          resourceId: identity.id,
          resourceName: identity.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            scope: tenantId ? "Tenant" : "Platform",
            clientId: identity.clientId,
          },
        },
      });
      return "Persisted" as const;
    } catch {
      return "Failed" as const;
    }
  }

  private async getTenantRecord(tenantId: string, serviceIdentityId: string) {
    const rows = await this.prisma.$queryRaw<ServiceIdentityCredentialRecord[]>`
      SELECT "id", "tenantId", "name", "zitadelUserId", "clientId"
      FROM "ServiceIdentity"
      WHERE "id" = CAST(${serviceIdentityId} AS uuid)
        AND "tenantId" = CAST(${tenantId} AS uuid)
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException("Service identity not found");
    return rows[0];
  }

  private async getPlatformRecord(serviceIdentityId: string) {
    const rows = await this.prisma.$queryRaw<ServiceIdentityCredentialRecord[]>`
      SELECT "id", "tenantId", "name", "zitadelUserId", "clientId"
      FROM "ServiceIdentity"
      WHERE "id" = CAST(${serviceIdentityId} AS uuid)
        AND "tenantId" IS NULL
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException("Platform service identity not found");
    return rows[0];
  }
}
