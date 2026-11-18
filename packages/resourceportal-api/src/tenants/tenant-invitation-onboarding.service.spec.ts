import { UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantInvitationOnboardingService } from "./tenant-invitation-onboarding.service";

const rawToken = "A".repeat(43);
const configValues: Record<string, string> = {
  RP_INVITATION_ONBOARDING_ENABLED: "true",
  OIDC_INVITATION_CLIENT_ID: "independent-onboard-client",
  OIDC_INVITATION_CLIENT_SECRET: "separate-confidential-client-secret-00001",
  OIDC_INVITATION_REDIRECT_URI: "https://rp.example.test/api/invitations/onboard/callback",
  OIDC_CLIENT_ID: "rp-web-client",
  OIDC_CLI_CLIENT_ID: "rp-cli-client",
};
function setup(values: Record<string,string> = {}) {
  const db = {
    tenantInvitation: { findUnique: vi.fn().mockResolvedValue({
      email: "member@example.test", roleIds: ["sso-login"],
      nativeApplicationKeys: ["web"], tenantId: "tenant-a",
      expiresAt: new Date(Date.now() + 60_000),
    }) },
  };
  const oidc = {
    getDiscovery: vi.fn().mockResolvedValue({
      authorizationEndpoint: "https://auth.example.test/oauth/authorize",
      tokenEndpoint: "https://auth.example.test/oauth/token",
    }),
    authenticateInvitationTokens: vi.fn().mockResolvedValue({
      id: "u-1", email: "member@example.test", status: UserStatus.Active,
    }),
  };
  const tenants = { acceptInvitation: vi.fn().mockResolvedValue({ tenantId: "tenant-a" }) };
  const config = { get: (key: string) => ({ ...configValues, ...values })[key] };
  const service = new TenantInvitationOnboardingService(db as never, oidc as never, tenants as never, config as never);
  return { service, db, oidc, tenants };
}

describe("#430 first-login invitation onboarding client (no RP session)", () => {
  it("advertises isolated flow only when issuer-global Actions V2 are certified and client is configured", () => {
    expect(setup().service.isOnboardingAvailable()).toBe(false);
    expect(setup({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" }).service.isOnboardingAvailable()).toBe(true);
    expect(setup({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "false" }).service.isOnboardingAvailable()).toBe(false);
    expect(setup({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      OIDC_INVITATION_CLIENT_ID: configValues.OIDC_CLIENT_ID }).service.isOnboardingAvailable()).toBe(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses only an isolated physical OIDC client and PKCE with nonce, never the RP project audience", async () => {
    const f = setup();
    const request = await f.service.start(rawToken, false);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://auth.example.test");
    expect(url.searchParams.get("client_id")).toBe(configValues.OIDC_INVITATION_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(configValues.OIDC_INVITATION_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.has("refresh_token")).toBe(false);
    expect(url.searchParams.get("nonce")).toBe(request.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request.verifier).toHaveLength(43);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(f.db.tenantInvitation.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) as string },
      select: {
        email: true, expiresAt: true, roleIds: true, tenantId: true,
        nativeApplicationKeys: true,
      },
    });
    expect(f.tenants.acceptInvitation).not.toHaveBeenCalled();
  });

  it("requires valid nonexpired invitation explicitly containing sso-login", async () => {
    const f = setup();
    f.db.tenantInvitation.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.start(rawToken, false)).rejects.toThrow("Invalid or expired");
    f.db.tenantInvitation.findUnique.mockResolvedValueOnce({
      email: "member@example.test", roleIds: ["tenant-admin"],
      nativeApplicationKeys: ["web"], expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(f.service.start(rawToken, true)).rejects.toThrow("Invalid or expired");
    f.db.tenantInvitation.findUnique.mockResolvedValueOnce({
      email: "member@example.test", roleIds: ["sso-login"],
      nativeApplicationKeys: ["web"], expiresAt: new Date(Date.now() - 1000),
    });
    await expect(f.service.start(rawToken, false)).rejects.toThrow("Invalid or expired");
    expect(f.oidc.getDiscovery).not.toHaveBeenCalled();
  });

  it("rejects same physical client as RP Web/CLI, disabled feature or non-HTTPS callback", async () => {
    for(const values of [
      { RP_INVITATION_ONBOARDING_ENABLED: "false" },
      { OIDC_INVITATION_CLIENT_ID: configValues.OIDC_CLIENT_ID },
      { OIDC_INVITATION_CLIENT_ID: configValues.OIDC_CLI_CLIENT_ID },
      { OIDC_INVITATION_REDIRECT_URI: "http://rp.example.test/api/invitations/onboard/callback" },
      { OIDC_INVITATION_CLIENT_SECRET: "" },
    ]) {
      const f = setup(values);
      await expect(f.service.start(rawToken, false)).rejects.toThrow();
      expect(f.db.tenantInvitation.findUnique).not.toHaveBeenCalled();
    }
  });

  it("validates signed state and one-time invite before calling the OAuth token endpoint", async () => {
    const f = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(f.service.complete("code", "bad-state", "expected", "verifier", rawToken))
      .rejects.toThrow("Invalid invitation OAuth callback state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.db.tenantInvitation.findUnique).not.toHaveBeenCalled();
    f.db.tenantInvitation.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.complete("code", "same", "same", "verifier", rawToken))
      .rejects.toThrow("Invalid or expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts after authenticated ID-token validation, commits membership, without creating any RP session", async () => {
    const f = setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id_token: "signed-onboarding-id", access_token: "onboarding-only-access", refresh_token: "ignored" }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(f.service.complete("one-time-code", "signed-state", "signed-state", "verifier", rawToken))
      .resolves.toEqual({ tenantId: "tenant-a", webGranted: true });
    expect(f.oidc.authenticateInvitationTokens).toHaveBeenCalledWith(
      "signed-onboarding-id", "onboarding-only-access", "signed-state", "member@example.test",
    );
    expect(f.tenants.acceptInvitation).toHaveBeenCalledWith({
      token: rawToken,
    }, expect.objectContaining({ id: "u-1", email: "member@example.test" }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as URLSearchParams).get("client_id")).toBe("independent-onboard-client");
    expect((init.body as URLSearchParams).get("code_verifier")).toBe("verifier");
  });

  it("accepts HA-only SSO without creating an RP Web entitlement", async () => {
    const f = setup();
    f.db.tenantInvitation.findUnique.mockResolvedValueOnce({
      email: "member@example.test", roleIds: ["sso-login"],
      nativeApplicationKeys: [], expiresAt: new Date(Date.now()+60_000),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({id_token:"id",access_token:"access"}), {status:200},
    )));
    expect(await f.service.complete("code", "state", "state", "verifier", rawToken))
      .toEqual({ tenantId: "tenant-a", webGranted: false });
  });

  it("denies malformed token response and preserves invitation on OAuth failure", async () => {
    const f = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id_token: "not-an-access-token" }), { status: 200 },
    )));
    await expect(f.service.complete("code", "state", "state", "verifier", rawToken))
      .rejects.toThrow("Invitation ID token missing");
    expect(f.oidc.authenticateInvitationTokens).not.toHaveBeenCalled();
    expect(f.tenants.acceptInvitation).not.toHaveBeenCalled();
  });
});
