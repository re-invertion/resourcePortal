import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { ZitadelOAuthApplicationService } from "./zitadel-oauth-application.service";

type OAuthApplicationCredentialRecord = {
  id: string;
  tenantId: string | null;
  name: string;
  type: string;
  zitadelApplicationId: string;
  clientId: string;
  clientSecretCiphertext: string | null;
};

@Injectable()
export class OAuthApplicationCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelOAuthApplicationService,
  ) {}

  async rotateTenant(
    tenantId: string,
    applicationId: string,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const application = await this.getTenantRecord(tenantId, applicationId);
    return this.rotate(application, actor, tenantId, tenant.name);
  }

  async rotatePlatform(applicationId: string, actor: AuthenticatedUser) {
    const application = await this.getPlatformRecord(applicationId);
    return this.rotate(application, actor, null, "platform");
  }

  private async rotate(
    application: OAuthApplicationCredentialRecord,
    actor: AuthenticatedUser,
    tenantId: string | null,
    tenantName: string,
  ) {
    if (!application.clientSecretCiphertext) {
      throw new BadRequestException(
        "This OAuth application type does not use a client secret",
      );
    }

    const clientSecret = await this.zitadel.rotateSecret(
      application.zitadelApplicationId,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "OAuthApplication"
        SET "clientSecretCiphertext" = ${this.encryption.encrypt(clientSecret)},
            "updatedBy" = CAST(${actor.id} AS uuid),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${application.id} AS uuid)
      `;
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName,
          actor: actor.id,
          actorName: actor.displayName,
          action: "oauth_application.credential.rotate",
          resourceType: "OAuthApplication",
          resourceId: application.id,
          resourceName: application.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            scope: tenantId ? "Tenant" : "Platform",
            type: application.type,
            clientId: application.clientId,
          },
        },
      });
    });

    return {
      id: application.id,
      clientId: application.clientId,
      clientSecret,
    };
  }

  private async getTenantRecord(tenantId: string, applicationId: string) {
    const rows = await this.prisma.$queryRaw<OAuthApplicationCredentialRecord[]>`
      SELECT "id", "tenantId", "name", "type", "zitadelApplicationId", "clientId", "clientSecretCiphertext"
      FROM "OAuthApplication"
      WHERE "id" = CAST(${applicationId} AS uuid)
        AND "tenantId" = CAST(${tenantId} AS uuid)
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException("OAuth application not found");
    return rows[0];
  }

  private async getPlatformRecord(applicationId: string) {
    const rows = await this.prisma.$queryRaw<OAuthApplicationCredentialRecord[]>`
      SELECT "id", "tenantId", "name", "type", "zitadelApplicationId", "clientId", "clientSecretCiphertext"
      FROM "OAuthApplication"
      WHERE "id" = CAST(${applicationId} AS uuid)
        AND "tenantId" IS NULL
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException("Platform OAuth application not found");
    return rows[0];
  }
}
