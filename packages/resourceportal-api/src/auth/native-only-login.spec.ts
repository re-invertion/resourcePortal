import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { AuthFlowService } from "./auth-flow.service";
import type { OidcAuthService } from "./oidc-auth.service";
import type { AuthSessionService } from "./auth-session.service";

function fixture() {
  const cfg = {
    RP_NATIVE_LOGIN_ONLY: "true",
    OIDC_CLIENT_ID: "rp-portal",
    OIDC_REDIRECT_URI: "https://rp.example.com/api/auth/callback",
    OIDC_ISSUER_URL: "https://login.example.com",
    ZITADEL_ORGANIZATION_ID: "org-123",
  };
  const prisma = {
    identityProvider: { findMany: vi.fn() },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        authPolicy: {
          requireTenantIdentityProvider: true,
          allowPlatformLogin: false,
        },
      }),
    },
  };
  const oidc = {
    getDiscovery: vi.fn().mockResolvedValue({
      authorizationEndpoint: "https://login.example.com/oauth/v2/authorize",
      tokenEndpoint: "https://login.example.com/oauth/v2/token",
    }),
    authenticateBrowserTokens: vi.fn().mockResolvedValue({
      id: "user-1", status: UserStatus.Active, authenticatedIdpId: null,
    }),
  };
  const sessions = { createSession: vi.fn().mockResolvedValue({ id: "session-1" }) };
  const service = new AuthFlowService(
    { get: (key: string) => (cfg as Record<string, string>)[key] } as ConfigService,
    oidc as unknown as OidcAuthService,
    sessions as unknown as AuthSessionService,
    prisma as unknown as PrismaService,
  );
  return { service, prisma, oidc, sessions };
}

describe("RP native-only authentication cutover", () => {
  it("does not list incoming external providers", async () => {
    const f = fixture();
    expect(await f.service.listLoginOptions("tenant-1")).toEqual([]);
    expect(f.prisma.identityProvider.findMany).not.toHaveBeenCalled();
  });
  it("rejects explicit provider selection even for a formerly enabled tenant", async () => {
    const f = fixture();
    await expect(f.service.createLoginRequest({
      tenantId: "tenant-1",
      identityProviderId: "old-idp",
    })).rejects.toThrow("External identity provider login is disabled");
  });
  it("allows native platform login despite a legacy tenant policy requirement", async () => {
    const f = fixture();
    const auth = await f.service.createLoginRequest({ tenantId: "tenant-1" });
    const url = new URL(auth.authorizationUrl);
    expect(url.searchParams.get("login_hint")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
  it("refuses ZITADEL-attested upstream login without query selection before issuing a session", async () => {
    const f = fixture();
    f.oidc.authenticateBrowserTokens.mockResolvedValue({
      id: "user-1", status: UserStatus.Active, authenticatedIdpId: "zitadel-external-123",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "token", id_token: "id-token", refresh_token: "refresh",
      }), { status: 200 }),
    ));
    try {
      await expect(f.service.handleCallback(
        "auth-code", "state-valid", "state-valid", "verifier",
      )).rejects.toThrow("External identity provider login is disabled");
      expect(f.sessions.createSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects callbacks bound to a previously selected upstream IdP", async () => {
    const f = fixture();
    await expect(f.service.handleCallback(
      "auth-code", "state-valid", "state-valid", "verifier", "old-idp",
    )).rejects.toThrow("External identity provider login is disabled");
  });
});
