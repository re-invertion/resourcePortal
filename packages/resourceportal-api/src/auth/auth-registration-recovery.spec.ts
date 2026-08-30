import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

function createConfig() {
  const values: Record<string, string> = {
    OIDC_CLIENT_ID: "resource-portal",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_REDIRECT_URI: "https://portal.example.com/api/auth/callback",
    ZITADEL_ORGANIZATION_ID: "org-1",
  };
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (values[key] ?? defaultValue) as T,
  } as ConfigService;
}

function createService(userStatus = UserStatus.Active) {
  const oidc = {
    getDiscovery: vi.fn().mockResolvedValue({
      authorizationEndpoint: "https://issuer.example.com/oauth/v2/authorize",
      issuer: "https://issuer.example.com",
      jwksUri: "https://issuer.example.com/oauth/v2/keys",
      tokenEndpoint: "https://issuer.example.com/oauth/v2/token",
    }),
    authenticateBearerToken: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      displayName: "Example User",
      status: userStatus,
    }),
  } as unknown as OidcAuthService;
  const sessions = {
    createSession: vi.fn().mockResolvedValue({
      id: "session-1",
      expiresAt: new Date(Date.now() + 60_000),
    }),
  } as unknown as AuthSessionService;
  const prisma = {} as PrismaService;

  return {
    service: new AuthFlowService(createConfig(), oidc, sessions, prisma),
    oidc,
    sessions,
  };
}

describe("registration and recovery auth flows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts ZITADEL self-registration with prompt=create", async () => {
    const { service } = createService();

    const request = await service.createRegistrationRequest();
    const url = new URL(request.authorizationUrl);

    expect(url.searchParams.get("prompt")).toBe("create");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("starts account recovery through the provider-owned login flow", async () => {
    const { service } = createService();

    const request = await service.createRecoveryRequest();
    const url = new URL(request.authorizationUrl);

    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("client_id")).toBe("resource-portal");
  });

  it("does not create an RP session until ZITADEL confirms email verification", async () => {
    const { service, sessions } = createService(UserStatus.Pending);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            id_token: "id-token",
            refresh_token: "refresh-token",
            expires_in: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      service.handleCallback("code", "state", "state", "verifier"),
    ).rejects.toThrow("Email verification is required before login");
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
});
