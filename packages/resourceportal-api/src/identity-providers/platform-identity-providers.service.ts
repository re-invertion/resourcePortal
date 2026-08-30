import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  IdentityProvider,
  IdentityProviderProtocol,
  IdentityProviderScope,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { CreateIdentityProviderDto } from "./dto/create-identity-provider.dto";
import { UpdateIdentityProviderDto } from "./dto/update-identity-provider.dto";
import { mapIdentityProvider } from "./identity-providers.view";
import {
  ZitadelIdentityProviderService,
  ZitadelProviderConfiguration,
} from "./zitadel-identity-provider.service";

const defaultScopes = ["openid", "profile", "email"];

@Injectable()
export class PlatformIdentityProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly zitadel: ZitadelIdentityProviderService,
  ) {}

  async list() {
    const providers = await this.prisma.identityProvider.findMany({
      where: { scope: IdentityProviderScope.Platform, tenantId: null },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
    return providers.map(mapIdentityProvider);
  }

  async get(identityProviderId: string) {
    return mapIdentityProvider(await this.getRecord(identityProviderId));
  }

  async create(dto: CreateIdentityProviderDto, actor: AuthenticatedUser) {
    const configuration = this.createConfiguration(dto);
    this.validateConfiguration(configuration, true);
    const remoteId = await this.zitadel.provision(configuration);

    try {
      const provider = await this.prisma.$transaction(async (tx) => {
        const created = await tx.identityProvider.create({
          data: {
            scope: IdentityProviderScope.Platform,
            tenantId: null,
            name: configuration.name,
            protocol: configuration.protocol,
            zitadelIdentityProviderId: remoteId,
            issuer: configuration.issuer,
            metadataUrl: configuration.metadataUrl,
            clientId: configuration.clientId,
            clientSecretCiphertext: configuration.clientSecret
              ? this.encryption.encrypt(configuration.clientSecret)
              : null,
            scopes: configuration.scopes,
            usePkce: configuration.usePkce,
            enabled: configuration.enabled,
            provisionedAt: new Date(),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "Platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "platform_identity_provider.create",
            resourceType: "IdentityProvider",
            resourceId: created.id,
            resourceName: created.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: this.auditChanges(created),
          },
        });
        return created;
      });
      return mapIdentityProvider(provider);
    } catch (error) {
      await this.deleteRemoteIgnoringFailure(remoteId);
      this.rethrowConflict(error);
    }
  }

  async update(
    identityProviderId: string,
    dto: UpdateIdentityProviderDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.getRecord(identityProviderId);
    const configuration = this.updateConfiguration(current, dto);
    const protocolChanged = configuration.protocol !== current.protocol;
    const needsProvisioning = protocolChanged || !current.zitadelIdentityProviderId;

    if (
      needsProvisioning &&
      configuration.protocol === IdentityProviderProtocol.OIDC &&
      !configuration.clientSecret &&
      current.clientSecretCiphertext
    ) {
      configuration.clientSecret = this.encryption.decrypt(current.clientSecretCiphertext);
    }

    this.validateConfiguration(configuration, needsProvisioning);

    let remoteId = current.zitadelIdentityProviderId;
    if (needsProvisioning) {
      remoteId = await this.zitadel.provision(configuration);
    } else if (remoteId) {
      await this.zitadel.update(remoteId, configuration);
      if (configuration.enabled !== current.enabled) {
        await this.zitadel.setEnabled(remoteId, configuration.enabled);
      }
    }

    try {
      const provider = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.identityProvider.update({
          where: { id: current.id },
          data: {
            name: configuration.name,
            protocol: configuration.protocol,
            zitadelIdentityProviderId: remoteId,
            issuer: configuration.issuer,
            metadataUrl: configuration.metadataUrl,
            clientId: configuration.clientId,
            clientSecretCiphertext: this.updatedSecretCiphertext(
              current,
              configuration,
              protocolChanged,
            ),
            scopes: configuration.scopes,
            usePkce: configuration.usePkce,
            enabled: configuration.enabled,
            provisionedAt: new Date(),
            updatedBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "Platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "platform_identity_provider.update",
            resourceType: "IdentityProvider",
            resourceId: updated.id,
            resourceName: updated.name,
            result: "Success",
            correlationId: randomUUID(),
            changes: this.auditChanges(updated),
          },
        });
        return updated;
      });

      if (needsProvisioning && current.zitadelIdentityProviderId && current.zitadelIdentityProviderId !== remoteId) {
        await this.deleteRemoteIgnoringFailure(current.zitadelIdentityProviderId);
      }
      return mapIdentityProvider(provider);
    } catch (error) {
      if (needsProvisioning && remoteId && remoteId !== current.zitadelIdentityProviderId) {
        await this.deleteRemoteIgnoringFailure(remoteId);
      }
      this.rethrowConflict(error);
    }
  }

  async delete(identityProviderId: string, actor: AuthenticatedUser) {
    const provider = await this.getRecord(identityProviderId);
    if (provider.zitadelIdentityProviderId) {
      await this.zitadel.delete(provider.zitadelIdentityProviderId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.identityProvider.delete({ where: { id: provider.id } });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "platform_identity_provider.delete",
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

  private async getRecord(identityProviderId: string) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: {
        id: identityProviderId,
        scope: IdentityProviderScope.Platform,
        tenantId: null,
      },
    });
    if (!provider) {
      throw new NotFoundException("Platform identity provider not found");
    }
    return provider;
  }

  private createConfiguration(dto: CreateIdentityProviderDto): ZitadelProviderConfiguration {
    if (dto.protocol === IdentityProviderProtocol.OIDC) {
      return {
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        enabled: dto.enabled ?? true,
        issuer: dto.issuer,
        name: dto.name,
        protocol: dto.protocol,
        scopes: dto.scopes ?? defaultScopes,
        usePkce: dto.usePkce ?? true,
      };
    }
    return {
      enabled: dto.enabled ?? true,
      metadataUrl: dto.metadataUrl,
      name: dto.name,
      protocol: dto.protocol,
      scopes: [],
      usePkce: false,
    };
  }

  private updateConfiguration(current: IdentityProvider, dto: UpdateIdentityProviderDto): ZitadelProviderConfiguration {
    const protocol = dto.protocol ?? current.protocol;
    if (protocol === IdentityProviderProtocol.OIDC) {
      const currentIsOidc = current.protocol === IdentityProviderProtocol.OIDC;
      return {
        clientId: dto.clientId ?? (currentIsOidc ? current.clientId : null) ?? undefined,
        clientSecret: dto.clientSecret,
        enabled: dto.enabled ?? current.enabled,
        issuer: dto.issuer ?? (currentIsOidc ? current.issuer : null) ?? undefined,
        name: dto.name ?? current.name,
        protocol,
        scopes: dto.scopes ?? (currentIsOidc ? current.scopes : defaultScopes),
        usePkce: dto.usePkce ?? (currentIsOidc ? current.usePkce : true),
      };
    }
    return {
      enabled: dto.enabled ?? current.enabled,
      metadataUrl: dto.metadataUrl ?? (current.protocol === IdentityProviderProtocol.SAML ? current.metadataUrl : null) ?? undefined,
      name: dto.name ?? current.name,
      protocol,
      scopes: [],
      usePkce: false,
    };
  }

  private validateConfiguration(configuration: ZitadelProviderConfiguration, requireOidcSecret: boolean) {
    if (configuration.protocol === IdentityProviderProtocol.OIDC) {
      const missing = [
        !configuration.issuer ? "issuer" : undefined,
        !configuration.clientId ? "clientId" : undefined,
        requireOidcSecret && !configuration.clientSecret ? "clientSecret" : undefined,
      ].filter((field): field is string => Boolean(field));
      if (missing.length) {
        throw new BadRequestException(`OIDC identity provider requires: ${missing.join(", ")}`);
      }
      return;
    }
    if (!configuration.metadataUrl) {
      throw new BadRequestException("SAML identity provider requires: metadataUrl");
    }
  }

  private updatedSecretCiphertext(current: IdentityProvider, configuration: ZitadelProviderConfiguration, protocolChanged: boolean) {
    if (configuration.protocol !== IdentityProviderProtocol.OIDC) return null;
    if (configuration.clientSecret) return this.encryption.encrypt(configuration.clientSecret);
    return protocolChanged ? null : current.clientSecretCiphertext;
  }

  private auditChanges(provider: IdentityProvider) {
    return {
      scope: provider.scope,
      protocol: provider.protocol,
      enabled: provider.enabled,
      issuer: provider.issuer,
      metadataUrl: provider.metadataUrl,
      clientId: provider.clientId,
      scopes: provider.scopes,
      usePkce: provider.usePkce,
      zitadelIdentityProviderId: provider.zitadelIdentityProviderId,
    };
  }

  private async deleteRemoteIgnoringFailure(identityProviderId: string) {
    try {
      await this.zitadel.delete(identityProviderId);
    } catch {
      // Preserve the original database error; a later reconciliation can remove the orphan.
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("Platform identity provider already exists");
    }
    throw error;
  }
}
