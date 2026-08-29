import { randomBytes, createHash } from "node:crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

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
  ) {}

  async createLoginRequest() {
    const discovery = await this.oidcAuth.getDiscovery();
    const state = randomToken();
    const codeVerifier = randomToken();
    const url = new URL(discovery.authorizationEndpoint);

    url.searchParams.set("client_id", this.getClientId());
    url.searchParams.set("redirect_uri", this.getRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.getScopes().join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    return {
      authorizationUrl: url.toString(),
      codeVerifier,
      state,
    };
  }

  async handleCallback(
    code: string,
    state: string,
    expectedState: string | undefined,
    codeVerifier: string | undefined,
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
    );
    const session = await this.sessions.createSession(user.id, tokenResponse);

    return {
      session,
      user,
    };
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
