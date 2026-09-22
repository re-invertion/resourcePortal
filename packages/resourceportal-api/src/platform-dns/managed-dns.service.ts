import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DomainType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import {
  CloudflareApiError,
  CloudflareDnsRecordConflictError,
  CloudflareDnsService,
} from "./cloudflare-dns.service";
import type { UpdatePlatformDnsDto } from "./dto/update-platform-dns.dto";
import { PLATFORM_DNS_INTEGRATION_ID } from "./platform-dns.constants";

@Injectable()
export class ManagedDnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly cloudflare: CloudflareDnsService,
  ) {}

  async getPlatformState() {
    return this.toView(await this.getState());
  }

  async getTenantCapabilities() {
    const state = await this.getState();
    return {
      managedDomains: {
        enabled: this.isAvailable(state),
        provider: "Cloudflare",
        baseDomain: this.managedBaseDomain(),
      },
    };
  }

  async updatePlatformState(dto: UpdatePlatformDnsDto, actor: AuthenticatedUser) {
    const current = await this.getState();
    const nextZoneId = dto.zoneId?.trim() || current.zoneId;
    const nextToken = dto.apiToken?.trim() || this.decryptToken(current.apiTokenCiphertext);
    const nextEnabled = dto.enabled ?? current.enabled;

    if (dto.zoneId && current.zoneId && dto.zoneId !== current.zoneId) {
      const managedDomainCount = await this.prisma.domain.count({
        where: { type: DomainType.Managed },
      });
      if (managedDomainCount > 0) {
        throw new ConflictException(
          "Cloudflare zone cannot be changed while managed ResourcePortal domains exist",
        );
      }
    }

    let validation: { zoneId: string; zoneName: string } | undefined;
    const configurationChanged = Boolean(dto.zoneId || dto.apiToken);
    if (nextEnabled || configurationChanged) {
      if (!nextZoneId || !nextToken) {
        throw new BadRequestException(
          "Cloudflare zoneId and API token are required before managed domains can be enabled",
        );
      }
      try {
        validation = await this.cloudflare.validateConnection({
          apiToken: nextToken,
          zoneId: nextZoneId,
          managedBaseDomain: this.managedBaseDomain(),
        });
        if (nextEnabled) {
          await this.reconcileExistingManagedDomains({
            apiToken: nextToken,
            zoneId: nextZoneId,
          });
        }
      } catch (error) {
        await this.prisma.platformDnsIntegration.update({
          where: { id: PLATFORM_DNS_INTEGRATION_ID },
          data: { lastError: safeMessage(error), updatedBy: actor.id },
        });
        this.throwCloudflareHttpError(error);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const state = await tx.platformDnsIntegration.update({
        where: { id: PLATFORM_DNS_INTEGRATION_ID },
        data: {
          enabled: nextEnabled,
          zoneId: nextZoneId,
          zoneName: validation?.zoneName ?? current.zoneName,
          apiTokenCiphertext: dto.apiToken
            ? this.encryption.encrypt(dto.apiToken.trim())
            : undefined,
          oauthClientId: dto.oauthClientId?.trim() || undefined,
          oauthClientSecretCiphertext: dto.oauthClientSecret
            ? this.encryption.encrypt(dto.oauthClientSecret.trim())
            : undefined,
          lastValidatedAt: validation ? new Date() : undefined,
          lastError: validation ? null : undefined,
          updatedBy: actor.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "platform_dns.update",
          resourceType: "PlatformDnsIntegration",
          resourceId: state.id,
          resourceName: "Cloudflare managed DNS",
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            provider: state.provider,
            enabled: state.enabled,
            zoneId: state.zoneId,
            zoneName: state.zoneName,
            tokenConfigured: Boolean(state.apiTokenCiphertext),
            tenantOauthConfigured: Boolean(
              state.oauthClientId && state.oauthClientSecretCiphertext,
            ),
          },
        },
      });
      return state;
    });
    return this.toView(updated);
  }

  async validatePlatformConnection(actor: AuthenticatedUser) {
    const state = await this.getState();
    const configuration = this.configuration(state, false);
    try {
      const validation = await this.cloudflare.validateConnection({
        apiToken: configuration.apiToken,
        zoneId: configuration.zoneId,
        managedBaseDomain: this.managedBaseDomain(),
      });
      const updated = await this.prisma.platformDnsIntegration.update({
        where: { id: PLATFORM_DNS_INTEGRATION_ID },
        data: {
          zoneName: validation.zoneName,
          lastValidatedAt: new Date(),
          lastError: null,
          updatedBy: actor.id,
        },
      });
      return this.toView(updated);
    } catch (error) {
      await this.prisma.platformDnsIntegration.update({
        where: { id: PLATFORM_DNS_INTEGRATION_ID },
        data: { lastError: safeMessage(error), updatedBy: actor.id },
      });
      this.throwCloudflareHttpError(error);
    }
  }

  async getTenantOauthConfiguration() {
    const state = await this.getState();
    if (!state.oauthClientId || !state.oauthClientSecretCiphertext) {
      throw new ConflictException(
        "Cloudflare tenant OAuth is not configured by the Platform Administrator",
      );
    }
    return {
      clientId: state.oauthClientId,
      clientSecret: this.encryption.decrypt(state.oauthClientSecretCiphertext),
      redirectUri: this.cloudflareOauthRedirectUri(),
    };
  }

  async provisionManagedDomain(hostname: string) {
    const state = await this.getState();
    const configuration = this.configuration(state, true);
    try {
      return await this.cloudflare.ensureManagedCname({
        ...configuration,
        hostname,
        targetHostname: this.targetHostname(),
      });
    } catch (error) {
      this.throwCloudflareHttpError(error);
    }
  }

  async deleteManagedDomain(hostname: string) {
    const state = await this.getState();
    const configuration = this.configuration(state, false);
    try {
      return await this.cloudflare.deleteManagedCname({
        ...configuration,
        hostname,
        targetHostname: this.targetHostname(),
      });
    } catch (error) {
      this.throwCloudflareHttpError(error);
    }
  }

  async managedDomainExists(hostname: string) {
    const state = await this.getState();
    if (!state.apiTokenCiphertext || !state.zoneId) return false;
    const configuration = this.configuration(state, false);
    try {
      return await this.cloudflare.hasManagedCname({
        ...configuration,
        hostname,
        targetHostname: this.targetHostname(),
      });
    } catch (error) {
      this.throwCloudflareHttpError(error);
    }
  }

  private throwCloudflareHttpError(error: unknown): never {
    if (error instanceof CloudflareDnsRecordConflictError) {
      throw new ConflictException({
        code: "CloudflareDnsRecordConflict",
        message: error.message,
        details: {
          hostname: error.hostname,
          existingRecords: error.records.map((record) => ({
            type: record.type,
            content: record.content,
          })),
        },
      });
    }
    if (error instanceof CloudflareApiError) {
      if (error.category === "configuration") {
        throw new BadRequestException({
          code: "CloudflareConfigurationError",
          message: error.message,
        });
      }
      throw new BadGatewayException({
        code: "CloudflareUpstreamError",
        message: error.message,
      });
    }
    throw error;
  }

  private async reconcileExistingManagedDomains(configuration: {
    apiToken: string;
    zoneId: string;
  }) {
    const domains = await this.prisma.domain.findMany({
      where: { type: DomainType.Managed },
      select: { hostname: true },
      orderBy: { hostname: "asc" },
    });
    for (const domain of domains) {
      await this.cloudflare.ensureManagedCname({
        ...configuration,
        hostname: domain.hostname,
        targetHostname: this.targetHostname(),
      });
    }
  }

  private async getState() {
    return this.prisma.platformDnsIntegration.upsert({
      where: { id: PLATFORM_DNS_INTEGRATION_ID },
      create: {
        id: PLATFORM_DNS_INTEGRATION_ID,
        provider: "Cloudflare",
        enabled: false,
      },
      update: {},
    });
  }

  private configuration(
    state: Awaited<ReturnType<ManagedDnsService["getState"]>>,
    requireEnabled: boolean,
  ) {
    if (requireEnabled && !this.isAvailable(state)) {
      throw new ConflictException(
        "Managed ResourcePortal domains are disabled by the Platform Administrator",
      );
    }
    if (!state.zoneId || !state.apiTokenCiphertext) {
      throw new ConflictException(
        "Cloudflare managed DNS is not configured",
      );
    }
    return {
      zoneId: state.zoneId,
      apiToken: this.encryption.decrypt(state.apiTokenCiphertext),
    };
  }

  private isAvailable(state: {
    enabled: boolean;
    zoneId: string | null;
    apiTokenCiphertext: string | null;
    lastValidatedAt: Date | null;
    lastError: string | null;
  }) {
    return Boolean(
      state.enabled &&
        state.zoneId &&
        state.apiTokenCiphertext &&
        state.lastValidatedAt &&
        !state.lastError,
    );
  }

  private toView(state: Awaited<ReturnType<ManagedDnsService["getState"]>>) {
    return {
      provider: state.provider,
      enabled: state.enabled,
      available: this.isAvailable(state),
      configured: Boolean(state.zoneId && state.apiTokenCiphertext),
      tokenConfigured: Boolean(state.apiTokenCiphertext),
      tenantOauthConfigured: Boolean(
        state.oauthClientId && state.oauthClientSecretCiphertext,
      ),
      oauthClientId: state.oauthClientId,
      oauthClientSecretConfigured: Boolean(state.oauthClientSecretCiphertext),
      oauthRedirectUri: this.cloudflareOauthRedirectUri(),
      zoneId: state.zoneId,
      zoneName: state.zoneName,
      baseDomain: this.managedBaseDomain(),
      targetHostname: this.targetHostname(),
      lastValidatedAt: state.lastValidatedAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    };
  }

  private cloudflareOauthRedirectUri() {
    const base = this.config
      .get<string>("PUBLIC_API_URL", `http://localhost:${this.config.get("PORT", 3000)}`)
      .replace(/\/$/, "");
    return `${base}/api/integrations/cloudflare/oauth/callback`;
  }

  private managedBaseDomain() {
    return normalizeHostname(
      this.config.get<string>(
        "MANAGED_DOMAIN_BASE",
        "apps.resource-portal.local",
      ),
    );
  }

  private targetHostname() {
    return normalizeHostname(
      this.config.get<string>(
        "RESOURCEPORTAL_PUBLIC_HOSTNAME",
        this.managedBaseDomain(),
      ),
    );
  }

  private decryptToken(ciphertext: string | null) {
    return ciphertext ? this.encryption.decrypt(ciphertext) : undefined;
  }
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : "Cloudflare connection failed";
}
