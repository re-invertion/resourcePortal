import { randomBytes, createHash } from "node:crypto";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdentityProviderScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";
import { LoginQueryDto } from "./dto/login-query.dto";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in?: number;
};

@Injectable()
export class AuthFlowService {
  constructor(
    private readonly config: ConfigService,
    private readonly oidcAuth: OidcAuthService,
    private readonly sessions: AuthSessionService,
    private readonly prisma: PrismaService,
  ) {}

  async createLoginRequest(options: LoginQueryDto = {}) {
    const discovery = await this.oidcAuth.getDiscovery();
    const selection = await this.resolveLoginSelection(options);
    const state = randomToken();
    const codeVerifier = randomToken();
    const url = new URL(discovery.authorizationEndpoint);

    url.searchParams.set("client_id", this.getClientId());
    url.searchParams.set("redirect_uri", this.getRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", selection.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    return {
      authorizationUrl: url.toString(),
      codeVerifier,
      identityProviderId: selection.identityProviderId,
      state,
    };
  }

  async handleCallback(
    code: string,
    state: string,
    expectedState: string | undefined,
    codeVerifier: string | undefined,
    identityProviderId?: string,
  ) {
    if (!state || state !== expectedState) {
      throw new UnauthorizedException("OIDC state is invalid");
    }

    if (!codeVerifier) {
      throw new UnauthorizedException("OIDC code verifier is missing");
    }

    const tokenResponse = await this.exchangeCode(code, codeVerifier);
    const user = await this.oidcAuth.authenticateBearerToken(
      tokenResponse.id_token,
      identityProviderId,
    );
    const session = await this.sessions.createSession(user.id, tokenResponse);

    return {
      session,
      user,
    };
  }

  async listLoginOptions(tenantId?: string) {
    if (!tenantId) {
      return this.prisma.identityProvider.findMany({
        where: {
          enabled: true,
          scope: IdentityProviderScope.Platform,
          tenantId: null,
          zitadelIdentityProviderId: { not: null },
        },
        orderBy: { name: "asc" },
        select: { id: true, name: true, protocol: true, scope: true },
      });
    }

    const policy = await this.getTenantLoginPolicy(tenantId);
    const scopes = [
      ...(policy.allowPlatformLogin && !policy.requireTenantIdentityProvider
        ? [IdentityProviderScope.Platform]
        : []),
      ...(policy.allowTenantIdentityProviders
        ? [IdentityProviderScope.Tenant]
        : []),
    ];

    if (scopes.length === 0) {
      return [];
    }

    return this.prisma.identityProvider.findMany({
      where: {
        enabled: true,
        zitadelIdentityProviderId: { not: null },
        OR: scopes.map((scope) =>
          scope === IdentityProviderScope.Platform
            ? { scope, tenantId: null }
            : { scope, tenantId },
        ),
      },
      orderBy: [{ scope: "asc" }, { name: "asc" }],
      select: { id: true, name: true, protocol: true, scope: true },
    });
  }

  private async resolveLoginSelection(options: LoginQueryDto) {
    const scopes = this.getScopes();
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");

    if (organizationId) {
      scopes.push(`urn:zitadel:iam:org:id:${organizationId}`);
    }

    if (!options.tenantId && !options.identityProviderId) {
      return { scopes: [...new Set(scopes)] };
    }

    const policy = options.tenantId
      ? await this.getTenantLoginPolicy(options.tenantId)
      : undefined;

    if (!options.identityProviderId) {
      if (policy?.requireTenantIdentityProvider || policy?.allowPlatformLogin === false) {
        throw new ForbiddenException(
          "This tenant requires an enabled tenant identity provider",
        );
      }

      return { scopes: [...new Set(scopes)] };
    }

    const provider = await this.prisma.identityProvider.findFirst({
      where: {
        id: options.identityProviderId,
        enabled: true,
        zitadelIdentityProviderId: { not: null },
        OR: options.tenantId
          ? [
              { scope: IdentityProviderScope.Platform, tenantId: null },
              {
                scope: IdentityProviderScope.Tenant,
                tenantId: options.tenantId,
              },
            ]
          : [{ scope: IdentityProviderScope.Platform, tenantId: null }],
      },
    });

    if (!provider?.zitadelIdentityProviderId) {
      throw new NotFoundException("Enabled identity provider not found");
    }

    if (
      provider.scope === IdentityProviderScope.Platform &&
      policy &&
      (!policy.allowPlatformLogin || policy.requireTenantIdentityProvider)
    ) {
      throw new ForbiddenException("Platform login is disabled for this tenant");
    }

    if (
      provider.scope === IdentityProviderScope.Tenant &&
      policy &&
      !policy.allowTenantIdentityProviders
    ) {
      throw new ForbiddenException(
        "Tenant identity providers are disabled for this tenant",
      );
    }

    if (!organizationId) {
      throw new ServiceUnavailableException(
        "ZITADEL_ORGANIZATION_ID is required for identity provider selection",
      );
    }

    scopes.push(
      `urn:zitadel:iam:org:idp:id:${provider.zitadelIdentityProviderId}`,
    );

    return {
      scopes: [...new Set(scopes)],
      identityProviderId: provider.id,
    };
  }

  private async getTenantLoginPolicy(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { authPolicy: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return (
      tenant.authPolicy ?? {
        allowPlatformLogin: true,
        allowTenantIdentityProviders: true,
        requireTenantIdentityProvider: false,
      }
    );
  }

  private async exchangeCode(code: string, codeVerifier: string) {
    const discovery = await this.oidcAuth.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.getRedirectUri(),
      client_id: this.getClientId(),
      code_verifier: codeVerifier,
    });
    const clientSecret = this.getClientSecret();
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };

    if (clientSecret) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.getClientId()}:${clientSecret}`,
      ).toString("base64")}`;
    }

    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok || !isTokenResponse(payload)) {
      throw new UnauthorizedException("OIDC code exchange failed");
    }

    return payload;
  }

  getRedirectUri() {
    const configured = this.config.get<string>("OIDC_REDIRECT_URI");

    if (configured) {
      return configured;
    }

    return `${this.getPublicApiUrl()}/api/auth/callback`;
  }

  getPostLogoutRedirectUri() {
    return (
      this.config.get<string>("OIDC_POST_LOGOUT_REDIRECT_URI") ??
      `${this.getPublicApiUrl()}/api/auth/logout/callback`
    );
  }

  private getPublicApiUrl() {
    return this.config
      .get<string>("PUBLIC_API_URL", `http://localhost:${this.config.get("PORT", 3000)}`)
      .replace(/\/$/, "");
  }

  private getClientId() {
    const clientId = this.config.get<string>("OIDC_CLIENT_ID");

    if (!clientId) {
      throw new UnauthorizedException("OIDC_CLIENT_ID is required");
    }

    return clientId;
  }

  private getClientSecret() {
    return this.config.get<string>("OIDC_CLIENT_SECRET");
  }

  private getScopes() {
    return (
      this.config.get<string>("OIDC_SCOPES") ?? "openid profile email offline_access"
    )
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
}

function isTokenResponse(payload: unknown): payload is TokenResponse {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const value = payload as Record<string, unknown>;
  return (
    typeof value.access_token === "string" &&
    typeof value.id_token === "string"
  );
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}
