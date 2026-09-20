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
  tenantId: string;
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
export class OAuthApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelOAuthApplicationService,
  ) {}

  async list(tenantId: string) {
    await this.ensureTenant(tenantId);
    const records = await this.prisma.oAuthApplication.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
    });
    return records.map((record) => this.map(this.asTenantRecord(record)));
  }

  async get(tenantId: string, applicationId: string) {
    return this.map(await this.getRecord(tenantId, applicationId));
  }

  async create(tenantId: string, dto: CreateOAuthApplicationDto, actor: AuthenticatedUser) {
    const tenant = await this.ensureTenant(tenantId);
    const configuration = this.configuration(dto.name, dto.type, dto.redirectUris ?? [], dto.postLogoutRedirectUris ?? []);
    this.validate(configuration);
    const remote = await this.zitadel.provision(configuration);
    const id = randomUUID();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.oAuthApplication.create({
          data: {
            id,
            tenantId,
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
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "oauth_application.create",
            resourceType: "OAuthApplication",
            resourceId: id,
            resourceName: configuration.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
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

    const created = await this.getRecord(tenantId, id);
    return {
      ...this.map(created),
      ...(remote.clientSecret ? { clientSecret: remote.clientSecret } : {}),
    };
  }

  async update(
    tenantId: string,
    applicationId: string,
    dto: UpdateOAuthApplicationDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenant(tenantId);
    const current = await this.getRecord(tenantId, applicationId);
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
          where: { id: applicationId, tenantId },
          data: {
            name: configuration.name,
            redirectUris: configuration.redirectUris,
            postLogoutRedirectUris: configuration.postLogoutRedirectUris,
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "oauth_application.update",
            resourceType: "OAuthApplication",
            resourceId: applicationId,
            resourceName: configuration.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              redirectUris: configuration.redirectUris,
              postLogoutRedirectUris: configuration.postLogoutRedirectUris,
            },
          },
        });
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
    return this.get(tenantId, applicationId);
  }

  async delete(tenantId: string, applicationId: string, actor: AuthenticatedUser) {
    const tenant = await this.ensureTenant(tenantId);
    const current = await this.getRecord(tenantId, applicationId);
    await this.zitadel.delete(current.zitadelApplicationId);
    await this.prisma.$transaction(async (tx) => {
      await tx.oAuthApplication.deleteMany({
        where: { id: applicationId, tenantId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "oauth_application.delete",
          resourceType: "OAuthApplication",
          resourceId: applicationId,
          resourceName: current.name,
          result: "Success",
          correlationId: randomUUID(),
          changes: { type: current.type, clientId: current.clientId },
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

  private async getRecord(tenantId: string, applicationId: string) {
    const row = await this.prisma.oAuthApplication.findFirst({
      where: { id: applicationId, tenantId },
    });
    if (!row) throw new NotFoundException("OAuth application not found");
    return this.asTenantRecord(row);
  }

  private async ensureTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  private asTenantRecord(record: Awaited<ReturnType<PrismaService["oAuthApplication"]["findFirst"]>>) {
    if (!record || record.tenantId === null) {
      throw new NotFoundException("OAuth application not found");
    }
    return {
      ...record,
      tenantId: record.tenantId,
      type: record.type as OAuthApplicationType,
      redirectUris: record.redirectUris as string[],
      postLogoutRedirectUris: record.postLogoutRedirectUris as string[],
    } satisfies OAuthApplicationRecord;
  }

  private map(record: OAuthApplicationRecord) {
    return {
      id: record.id,
      tenantId: record.tenantId,
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
      throw new ConflictException("OAuth application already exists");
    }
    if (error instanceof Error && /unique constraint/i.test(error.message)) {
      throw new ConflictException("OAuth application already exists");
    }
    throw error;
  }
}
