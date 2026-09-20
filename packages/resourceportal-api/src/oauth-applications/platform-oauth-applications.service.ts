import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import {
  CreateOAuthApplicationDto,
  OAuthApplicationType,
} from "./dto/create-oauth-application.dto";
import { UpdateOAuthApplicationDto } from "./dto/update-oauth-application.dto";
import {
  ZitadelOAuthApplicationConfiguration,
  ZitadelOAuthApplicationService,
} from "./zitadel-oauth-application.service";

type OAuthApplicationRecord = {
  id: string;
  tenantId: null;
  name: string;
  type: OAuthApplicationType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  zitadelApplicationId: string;
  clientId: string;
  clientSecretCiphertext: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PlatformOAuthApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelOAuthApplicationService,
  ) {}

  async list() {
    const records = await this.prisma.oAuthApplication.findMany({
      where: { tenantId: null },
      orderBy: { name: "asc" },
    });
    return records.map((record) => this.map(this.asPlatformRecord(record)));
  }

  async get(applicationId: string) {
    return this.map(await this.getRecord(applicationId));
  }

  async create(dto: CreateOAuthApplicationDto, actor: AuthenticatedUser) {
    const configuration = this.configuration(
      dto.name,
      dto.type,
      dto.redirectUris ?? [],
      dto.postLogoutRedirectUris ?? [],
    );
    this.validate(configuration);
    const remote = await this.zitadel.provision(configuration);
    const id = randomUUID();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.oAuthApplication.create({
          data: {
            id,
            tenantId: null,
            name: configuration.name,
            type: configuration.type,
            redirectUris: configuration.redirectUris,
            postLogoutRedirectUris: configuration.postLogoutRedirectUris,
            zitadelApplicationId: remote.applicationId,
            clientId: remote.clientId,
            clientSecretCiphertext: remote.clientSecret
              ? this.encryption.encrypt(remote.clientSecret)
              : null,
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
            action: "oauth_application.create",
            resourceType: "OAuthApplication",
            resourceId: id,
            resourceName: configuration.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              scope: "Platform",
              type: configuration.type,
              redirectUris: configuration.redirectUris,
              postLogoutRedirectUris: configuration.postLogoutRedirectUris,
              clientId: remote.clientId,
            },
          },
        });
      });
    } catch (error) {
      await this.deleteRemoteIgnoringFailure(remote.applicationId);
      this.rethrowConflict(error);
    }

    const created = await this.getRecord(id);
    return {
      ...this.map(created),
      ...(remote.clientSecret ? { clientSecret: remote.clientSecret } : {}),
    };
  }

  async update(
    applicationId: string,
    dto: UpdateOAuthApplicationDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.getRecord(applicationId);
    const configuration = this.configuration(
      dto.name ?? current.name,
      current.type,
      dto.redirectUris ?? current.redirectUris,
      dto.postLogoutRedirectUris ?? current.postLogoutRedirectUris,
    );
    this.validate(configuration);
    await this.zitadel.update(current.zitadelApplicationId, configuration);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.oAuthApplication.updateMany({
          where: { id: applicationId, tenantId: null },
          data: {
            name: configuration.name,
            redirectUris: configuration.redirectUris,
            postLogoutRedirectUris: configuration.postLogoutRedirectUris,
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "oauth_application.update",
            resourceType: "OAuthApplication",
            resourceId: applicationId,
            resourceName: configuration.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              scope: "Platform",
              redirectUris: configuration.redirectUris,
              postLogoutRedirectUris: configuration.postLogoutRedirectUris,
            },
          },
        });
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
    return this.get(applicationId);
  }

  async delete(applicationId: string, actor: AuthenticatedUser) {
    const current = await this.getRecord(applicationId);
    await this.zitadel.delete(current.zitadelApplicationId);
    await this.prisma.$transaction(async (tx) => {
      await tx.oAuthApplication.deleteMany({
        where: { id: applicationId, tenantId: null },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "oauth_application.delete",
          resourceType: "OAuthApplication",
          resourceId: applicationId,
          resourceName: current.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { scope: "Platform", type: current.type, clientId: current.clientId },
        },
      });
    });
    return { deleted: true };
  }

  private configuration(
    name: string,
    type: OAuthApplicationType,
    redirectUris: string[],
    postLogoutRedirectUris: string[],
  ): ZitadelOAuthApplicationConfiguration {
    return { name, type, redirectUris, postLogoutRedirectUris };
  }

  private validate(configuration: ZitadelOAuthApplicationConfiguration) {
    if (configuration.type === "Machine") {
      if (configuration.redirectUris.length || configuration.postLogoutRedirectUris.length) {
        throw new BadRequestException("Machine applications do not accept redirect URIs");
      }
      return;
    }
    if (configuration.redirectUris.length === 0) {
      throw new BadRequestException(`${configuration.type} applications require at least one redirect URI`);
    }
    for (const uri of [...configuration.redirectUris, ...configuration.postLogoutRedirectUris]) {
      try {
        new URL(uri);
      } catch {
        throw new BadRequestException(`Invalid application URI: ${uri}`);
      }
    }
  }

  private async getRecord(applicationId: string) {
    const row = await this.prisma.oAuthApplication.findFirst({
      where: { id: applicationId, tenantId: null },
    });
    if (!row) throw new NotFoundException("Platform OAuth application not found");
    return this.asPlatformRecord(row);
  }

  private asPlatformRecord(record: NonNullable<Awaited<ReturnType<PrismaService["oAuthApplication"]["findFirst"]>>>) {
    return {
      ...record,
      tenantId: null,
      type: record.type as OAuthApplicationType,
      redirectUris: record.redirectUris as string[],
      postLogoutRedirectUris: record.postLogoutRedirectUris as string[],
    } satisfies OAuthApplicationRecord;
  }

  private map(record: OAuthApplicationRecord) {
    return {
      id: record.id,
      scope: "Platform" as const,
      tenantId: null,
      name: record.name,
      type: record.type,
      redirectUris: record.redirectUris,
      postLogoutRedirectUris: record.postLogoutRedirectUris,
      clientId: record.clientId,
      hasClientSecret: Boolean(record.clientSecretCiphertext),
      provisioned: Boolean(record.zitadelApplicationId),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async deleteRemoteIgnoringFailure(applicationId: string) {
    try {
      await this.zitadel.delete(applicationId);
    } catch {
      // Preserve the database error; reconciliation can remove the orphan application.
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("Platform OAuth application already exists");
    }
    if (error instanceof Error && /unique constraint|duplicate key/i.test(error.message)) {
      throw new ConflictException("Platform OAuth application already exists");
    }
    throw error;
  }
}
