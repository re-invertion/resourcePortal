import { BadGatewayException, BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { CloudflareApiError, CloudflareDnsService } from "./cloudflare-dns.service";
import { ManagedDnsService } from "./managed-dns.service";

const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const REQUIRED_SCOPES = ["zone.read", "dns.write"] as const;
const REQUESTED_SCOPES = [...REQUIRED_SCOPES, "offline_access"] as const;

type CloudflareTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

@Injectable()
export class CloudflareTenantOauthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly cloudflare: CloudflareDnsService,
    private readonly managedDns: ManagedDnsService,
  ) {}

  async getStatus(tenantId: string, userId: string) {
    const state = await this.managedDns.getPlatformState();
    const connection = await this.prisma.cloudflareOAuthConnection.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { accessTokenExpiresAt: true, scopes: true, updatedAt: true },
    });
    return {
      configured: state.tenantOauthConfigured === true,
      connected: Boolean(connection),
      scopes: connection?.scopes ?? [],
      accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
      updatedAt: connection?.updatedAt ?? null,
    };
  }

  async startAuthorization(tenantId: string, actor: AuthenticatedUser) {
    const configuration = await this.managedDns.getTenantOauthConfiguration();
    const rawState = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.prisma.cloudflareOAuthState.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    await this.prisma.cloudflareOAuthState.create({
      data: {
        id: randomUUID(),
        stateHash: this.hashState(rawState),
        tenantId,
        userId: actor.id,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    });

    const url = new URL(CLOUDFLARE_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", configuration.clientId);
    url.searchParams.set("redirect_uri", configuration.redirectUri);
    url.searchParams.set("scope", REQUESTED_SCOPES.join(" "));
    url.searchParams.set("state", rawState);
    return { authorizationUrl: url.toString() };
  }

  async resolveStateTenant(state: string, userId: string) {
    const row = await this.prisma.cloudflareOAuthState.findUnique({
      where: { stateHash: this.hashState(state) },
      select: { tenantId: true, userId: true, expiresAt: true, consumedAt: true },
    });
    if (!row || row.userId !== userId || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Cloudflare OAuth state is invalid or expired");
    }
    return row.tenantId;
  }

  async completeAuthorization(code: string, state: string, actor: AuthenticatedUser) {
    const stateRow = await this.prisma.cloudflareOAuthState.findUnique({
      where: { stateHash: this.hashState(state) },
    });
    if (!stateRow || stateRow.consumedAt || stateRow.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Cloudflare OAuth state is invalid or expired");
    }
    if (stateRow.userId !== actor.id) {
      throw new UnauthorizedException("Cloudflare OAuth state belongs to another user");
    }

    const configuration = await this.managedDns.getTenantOauthConfiguration();
    const token = await this.exchangeToken(configuration, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: configuration.redirectUri,
    }));
    const scopes = token.scope
      ? this.parseScopes(token.scope)
      : [...REQUESTED_SCOPES];
    this.assertRequiredScopes(scopes);

    const consumed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.cloudflareOAuthState.updateMany({
        where: { id: stateRow.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (result.count !== 1) return false;
      await tx.cloudflareOAuthConnection.upsert({
        where: { tenantId_userId: { tenantId: stateRow.tenantId, userId: actor.id } },
        create: {
          tenantId: stateRow.tenantId,
          userId: actor.id,
          accessTokenCiphertext: this.encryption.encrypt(token.access_token),
          refreshTokenCiphertext: token.refresh_token
            ? this.encryption.encrypt(token.refresh_token)
            : null,
          accessTokenExpiresAt: this.expiresAt(token.expires_in),
          scopes,
        },
        update: {
          accessTokenCiphertext: this.encryption.encrypt(token.access_token),
          refreshTokenCiphertext: token.refresh_token
            ? this.encryption.encrypt(token.refresh_token)
            : undefined,
          accessTokenExpiresAt: this.expiresAt(token.expires_in),
          scopes,
        },
      });
      return true;
    });
    if (!consumed) {
      throw new UnauthorizedException("Cloudflare OAuth state was already consumed");
    }
    return { tenantId: stateRow.tenantId };
  }

  async listZones(tenantId: string, userId: string) {
    const token = await this.accessToken(tenantId, userId);
    try {
      return await this.cloudflare.listZones(token);
    } catch (error) {
      this.throwCloudflareHttpError(error);
    }
  }

  async ensureVerificationTxt(input: {
    tenantId: string;
    userId: string;
    zoneId: string;
    rootDomain: string;
    verificationToken: string;
  }) {
    const token = await this.accessToken(input.tenantId, input.userId);
    try {
      return await this.cloudflare.ensureVerificationTxt({
        apiToken: token,
        zoneId: input.zoneId,
        rootDomain: input.rootDomain,
        content: input.verificationToken,
      });
    } catch (error) {
      this.throwCloudflareHttpError(error);
    }
  }

  async disconnect(tenantId: string, userId: string) {
    const connection = await this.prisma.cloudflareOAuthConnection.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!connection) return { disconnected: true };
    const configuration = await this.managedDns.getTenantOauthConfiguration();
    const tokens = [
      this.encryption.decrypt(connection.accessTokenCiphertext),
      connection.refreshTokenCiphertext
        ? this.encryption.decrypt(connection.refreshTokenCiphertext)
        : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const token of tokens) {
      try { await this.revokeToken(configuration, token); } catch { /* best effort */ }
    }
    await this.prisma.cloudflareOAuthConnection.delete({
      where: { tenantId_userId: { tenantId, userId } },
    });
    return { disconnected: true };
  }

  private async accessToken(tenantId: string, userId: string) {
    const connection = await this.prisma.cloudflareOAuthConnection.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!connection) {
      throw new ConflictException("Connect Cloudflare before using this method");
    }
    const freshUntil = Date.now() + 60_000;
    if (!connection.accessTokenExpiresAt || connection.accessTokenExpiresAt.getTime() > freshUntil) {
      return this.encryption.decrypt(connection.accessTokenCiphertext);
    }
    if (!connection.refreshTokenCiphertext) {
      throw new UnauthorizedException("Cloudflare authorization expired; reconnect Cloudflare");
    }

    const configuration = await this.managedDns.getTenantOauthConfiguration();
    const token = await this.exchangeToken(configuration, new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.encryption.decrypt(connection.refreshTokenCiphertext),
    }));
    const scopes = token.scope ? this.parseScopes(token.scope) : connection.scopes;
    this.assertRequiredScopes(scopes);
    await this.prisma.cloudflareOAuthConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenCiphertext: this.encryption.encrypt(token.access_token),
        refreshTokenCiphertext: token.refresh_token
          ? this.encryption.encrypt(token.refresh_token)
          : undefined,
        accessTokenExpiresAt: this.expiresAt(token.expires_in),
        scopes,
      },
    });
    return token.access_token;
  }

  private throwCloudflareHttpError(error: unknown): never {
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

  private async exchangeToken(
    configuration: { clientId: string; clientSecret: string; redirectUri: string },
    body: URLSearchParams,
  ) {
    let response: Response;
    try {
      response = await fetch(CLOUDFLARE_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${configuration.clientId}:${configuration.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new BadGatewayException(`Cloudflare OAuth token request failed: ${this.safeMessage(error)}`);
    }
    const payload = await response.json().catch(() => ({})) as Partial<CloudflareTokenResponse> & { error?: string; error_description?: string };
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new BadGatewayException(
        payload.error_description || payload.error || `Cloudflare OAuth token exchange failed (${response.status})`,
      );
    }
    return payload as CloudflareTokenResponse;
  }

  private async revokeToken(
    configuration: { clientId: string; clientSecret: string },
    token: string,
  ) {
    const response = await fetch(CLOUDFLARE_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${configuration.clientId}:${configuration.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cloudflare token revocation failed (${response.status})`);
  }

  private parseScopes(value: string | undefined) {
    return (value ?? "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  private assertRequiredScopes(scopes: string[]) {
    const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missing.length) {
      throw new ConflictException(`Cloudflare authorization is missing required scopes: ${missing.join(", ")}`);
    }
  }

  private expiresAt(expiresIn: number | undefined) {
    return typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? new Date(Date.now() + Math.max(0, expiresIn) * 1000)
      : null;
  }

  private hashState(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private safeMessage(error: unknown) {
    return error instanceof Error ? error.message : "unknown error";
  }
}
