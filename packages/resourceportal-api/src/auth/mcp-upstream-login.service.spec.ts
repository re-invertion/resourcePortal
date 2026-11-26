import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcAuthService } from "./oidc-auth.service";
import { OidcIssuerTransport } from "./oidc-issuer-transport";
import { McpUpstreamLoginService } from "./mcp-upstream-login.service";

const origin = "https://rp.example.test";
const tenant = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const clientId = "rpocli_12345";
const upstreamClientId = "340396026519785524";
const discovery = {
  authorizationEndpoint: "https://zitadel.example.test/oauth/v2/authorize",
  tokenEndpoint: "https://zitadel.example.test/oauth/v2/token",
  registrationEndpoint: "https://zitadel.example.test/oauth/v2/register",
};
const input = {
  tenantId: tenant, clientId, resource: `${origin}/api/tenants/${tenant}/mcp`,
  redirectUri: callback, clientState: "chatgpt-state",
  scope: "mcp offline_access", challenge: "C".repeat(43),
};

function fixture() {
  const logins = new Map<string, {
    stateHash: string; tenantId: string; clientId: string;
    upstreamClientId: string; resource: string; redirectUri: string;
    clientState: string; scope: string; codeChallenge: string;
    verifierCipher: string; expiresAt: Date;
  }>();
  let client: { tenantId: string; clientId: string } | null = null;
  const reservations = new Map<string, { status: string; observedClientId?: string }>();
  const registration = {
    createMany: vi.fn((args: { data: { tenantId: string; status: string }; skipDuplicates: boolean }) => {
      expect(args.skipDuplicates).toBe(true);
      if (reservations.has(args.data.tenantId)) return Promise.resolve({ count: 0 });
      reservations.set(args.data.tenantId, { status: args.data.status });
      return Promise.resolve({ count: 1 });
    }),
    updateMany: vi.fn((args: { where: { tenantId: string; status: { in: string[] } };
      data: { status: string; observedClientId?: string } }) => {
      const reservation = reservations.get(args.where.tenantId);
      if (!reservation || !args.where.status.in.includes(reservation.status)) return Promise.resolve({ count: 0 });
      reservation.status = args.data.status;
      if (args.data.observedClientId !== undefined) reservation.observedClientId = args.data.observedClientId;
      return Promise.resolve({ count: 1 });
    }),
  };
  const prisma = {
    mcpOAuthUpstreamRegistration: registration,
    $transaction: vi.fn(async (fn: (tx: {
      mcpOAuthUpstreamClient: { create: (args: { data: { tenantId: string; clientId: string } }) =>
        Promise<{ tenantId: string; clientId: string }> };
      mcpOAuthUpstreamRegistration: typeof registration;
    }) => Promise<unknown>) => {
      const previous = client;
      try { return await fn({ mcpOAuthUpstreamClient: prisma.mcpOAuthUpstreamClient, mcpOAuthUpstreamRegistration: registration }); }
      catch (error) { client = previous; throw error; }
    }),
    mcpOAuthUpstreamClient: {
      findUnique: vi.fn().mockImplementation((args: { where: { tenantId?: string } }) =>
        Promise.resolve(client?.tenantId === args.where.tenantId ? client : null)),
      create: vi.fn().mockImplementation((args: { data: { tenantId: string; clientId: string } }) => {
        client = args.data;
        return Promise.resolve(client);
      }),
    },
    mcpOAuthUpstreamLogin: {
      create: vi.fn().mockImplementation((args: { data: typeof input & {
        stateHash: string; upstreamClientId: string; verifierCipher: string; expiresAt: Date;
      } }) => { logins.set(args.data.stateHash, args.data); return Promise.resolve(args.data); }),
      findUnique: vi.fn().mockImplementation((args: { where: { stateHash: string } }) =>
        Promise.resolve(logins.get(args.where.stateHash) ?? null)),
      deleteMany: vi.fn().mockImplementation((args: {
        where: { stateHash: string; expiresAt: { gt: Date } };
      }) => {
        const found = logins.get(args.where.stateHash);
        if (!found || found.expiresAt <= args.where.expiresAt.gt) return Promise.resolve({ count: 0 });
        logins.delete(args.where.stateHash);
        return Promise.resolve({ count: 1 });
      }),
    },
    mcpOAuthBrowserSession: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const config = { get: vi.fn((key: string) =>
    key === "OIDC_ISSUER_URL" ? "https://zitadel.example.test"
      : ["RP_APP_CONSUMER_ACTIONS_V2_ENABLED",
        "RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED"].includes(key) ? "true" : undefined),
  };
  const encryption = {
    encrypt: vi.fn((plain: string) => "sealed-" + plain),
    decrypt: vi.fn((sealed: string) => sealed.slice(7)),
  };
  const transport = vi.spyOn(OidcIssuerTransport.prototype, "fetch")
    .mockImplementation((url, stage, options) => {
      if (stage === "registration") {
        expect(String(url)).toBe(discovery.registrationEndpoint);
        if (typeof options.body !== "string") throw new Error("Invalid registration body");
        expect(JSON.parse(options.body)).toMatchObject({
          redirect_uris: [`${origin}/api/mcp/oauth/upstream/callback`],
          token_endpoint_auth_method: "none",
        });
        return Promise.resolve(new Response(JSON.stringify({
          client_id: upstreamClientId,
          redirect_uris: [`${origin}/api/mcp/oauth/upstream/callback`],
          token_endpoint_auth_method: "none",
        }), { status: 201 }));
      }
      if (stage === "code-exchange") {
        expect(String(url)).toBe(discovery.tokenEndpoint);
        if (!(options.body instanceof URLSearchParams)) throw new Error("Invalid code form");
        const form = options.body;
        expect(form.get("client_id")).toBe(upstreamClientId);
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(form.get("redirect_uri")).toBe(`${origin}/api/mcp/oauth/upstream/callback`);
        return Promise.resolve(new Response(
          JSON.stringify({
            id_token: "signed-issuer-jwt", access_token: "short-lived-userinfo-access",
          }), { status: 200 },
        ));
      }
      throw new Error("Unexpected stage");
    });
  const oidc = { getDiscovery: vi.fn().mockResolvedValue(discovery) };
  const svc = new McpUpstreamLoginService(
    prisma as unknown as PrismaService, config as unknown as ConfigService,
    oidc as unknown as OidcAuthService, encryption as unknown as EncryptionService,
  );
  const restart = () => new McpUpstreamLoginService(
    prisma as unknown as PrismaService, config as unknown as ConfigService,
    oidc as unknown as OidcAuthService, encryption as unknown as EncryptionService,
  );
  return { svc, prisma, encryption, transport, logins, oidc, reservations, restart };
}

afterEach(() => vi.restoreAllMocks());

describe("#442 MCP identity-only upstream OAuth PKCE, tenant scope and replay", () => {
  it("registers only an RP callback, starts PKCE S256 and seals the verifier at rest", async () => {
    const f = fixture();
    const flow = await f.svc.start(input, origin);
    const url = new URL(flow.url);
    expect(url.origin).toBe("https://zitadel.example.test");
    expect(url.searchParams.get("client_id")).toBe(upstreamClientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/mcp/oauth/upstream/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe(flow.state);
    expect(f.prisma.mcpOAuthUpstreamClient.create).toHaveBeenCalledTimes(1);
    expect(f.reservations.get(tenant)).toEqual({ status: "Bound", observedClientId: upstreamClientId });
    const login = [...f.logins.values()][0];
    expect(login.resource).toBe(input.resource);
    expect(login.tenantId).toBe(tenant);
    expect(login.clientState).toBe(input.clientState);
    expect(login.verifierCipher).toMatch(/^sealed-/);
    expect(login.verifierCipher).not.toContain(flow.state);
  });

  it.each([
    "https://attacker.invalid/oauth/v2/authorize",
    "http://zitadel.example.test/oauth/v2/authorize",
    "https://admin:secret@zitadel.example.test/oauth/v2/authorize",
    "https://zitadel.example.test/admin/privileged",
    "https://zitadel.example.test/oauth/v2/authorize?redirect=https://attacker.invalid",
    "https://zitadel.example.test/oauth/v2/authorize#forged",
    "not-a-url",
  ])("rejects untrusted authorization metadata before non-idempotent identity DCR (%s)", async (endpoint) => {
    const f = fixture();
    f.prisma.mcpOAuthUpstreamClient.findUnique.mockResolvedValue(null);
    const current = { ...discovery, authorizationEndpoint: endpoint };
    // No successful registration POST or RP pending consent is permitted.
    f.prisma.mcpOAuthUpstreamClient.create.mockClear();
    f.oidc.getDiscovery.mockResolvedValue(current);
    await expect(f.svc.start(input, origin))
      .rejects.toThrow("Untrusted ZITADEL authorization endpoint");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.invalid/oauth/v2/register",
    "http://zitadel.example.test/oauth/v2/register",
    "https://zitadel.example.test/oauth/v2/register/attacker",
    "https://zitadel.example.test/oauth/v2/register?redirect=https://attacker.invalid",
    "https://client:secret@zitadel.example.test/oauth/v2/register",
    "invalid-dcr-url",
  ])("rejects unsafe MCP upstream DCR discovery before any registration (%s)", async (endpoint) => {
    const f = fixture();
    // start() performs an authorization preflight first; upstreamClient()
    // independently fetches fresh discovery and validates the DCR endpoint.
    f.oidc.getDiscovery.mockResolvedValue({ ...discovery, registrationEndpoint: endpoint });
    await expect(f.svc.start(input, origin))
      .rejects.toThrow("Untrusted ZITADEL DCR registration endpoint");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example.test/oauth/v2/token",
    "http://zitadel.example.test/oauth/v2/token",
    "https://zitadel.example.test/admin/privileged",
    "https://zitadel.example.test/oauth/v2/token?leak=true",
    "https://client:password@zitadel.example.test/oauth/v2/token",
    "invalid-token-url",
  ])("rejects unsafe token metadata before identity DCR registration (%s)", async (endpoint) => {
    const f = fixture();
    f.oidc.getDiscovery.mockResolvedValue({ ...discovery, tokenEndpoint: endpoint });
    await expect(f.svc.start(input, origin))
      .rejects.toThrow("Untrusted ZITADEL token endpoint");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
  });

  it("reports an accepted upstream identity client as partial if the RP binding fails", async () => {
    const f = fixture();
    f.prisma.mcpOAuthUpstreamClient.create.mockRejectedValueOnce(new Error("P2002 race: secret DB internals"));
    let response: unknown;
    try { await f.svc.start(input, origin); } catch (error) {
      response = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(response).toMatchObject({
      code: "MCP_IDENTITY_DCR_PARTIAL_REGISTRATION", clientId: upstreamClientId,
    });
    expect(JSON.stringify(response)).not.toContain("secret DB internals");
    expect(f.reservations.get(tenant)).toEqual({ status: "Uncertain", observedClientId: upstreamClientId });
    await expect(f.restart().start(input, origin)).rejects.toMatchObject({
      response: { code: "MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED" },
    });
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "registration"))
      .toHaveLength(1);
  });

  it("serializes concurrent first-connect requests across service instances before the provider POST", async () => {
    const f = fixture();
    let release!: () => void;
    let dispatched!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    f.transport.mockImplementationOnce(async () => {
      dispatched();
      await pending;
      return Response.json({
        client_id: upstreamClientId,
        redirect_uris: [`${origin}/api/mcp/oauth/upstream/callback`],
        token_endpoint_auth_method: "none",
      }, { status: 201 });
    });
    const first = f.svc.start(input, origin);
    await started;
    await expect(f.restart().start(input, origin)).rejects.toMatchObject({
      response: { code: "MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED" },
    });
    release();
    await expect(first).resolves.toHaveProperty("url");
    await expect(f.restart().start(input, origin)).resolves.toHaveProperty("url");
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "registration")).toHaveLength(1);
    expect(f.prisma.mcpOAuthUpstreamClient.create).toHaveBeenCalledTimes(1);
    expect(f.reservations.get(tenant)?.status).toBe("Bound");
  });

  it("persists a dropped or rejected registration across restart without resubmitting DCR", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(new Response("private response", { status: 503 }));
    await expect(f.svc.start(input, origin)).rejects.toMatchObject({
      response: { code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN" },
    });
    expect(f.reservations.get(tenant)?.status).toBe("Uncertain");
    await expect(f.restart().start(input, origin)).rejects.toMatchObject({
      response: { code: "MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED" },
    });
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "registration")).toHaveLength(1);
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
  });

  it("blocks registration when the durable reservation cannot be committed", async () => {
    const f = fixture();
    f.prisma.mcpOAuthUpstreamRegistration.createMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.svc.start(input, origin)).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("classifies accepted identity DCR with malformed metadata as uncertain without binding", async () => {
    const f = fixture();
    f.transport.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
      client_id: upstreamClientId, redirect_uris: ["https://attacker.invalid/callback"],
      token_endpoint_auth_method: "none",
    }), { status: 201 })));
    let response: unknown;
    try { await f.svc.start(input, origin); } catch (error) {
      response = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(response).toMatchObject({
      code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN", clientId: upstreamClientId,
    });
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
  });

  it("classifies dropped identity DCR registration responses as uncertain without automatic retries", async () => {
    const f = fixture();
    f.transport.mockRejectedValueOnce(new Error("private issuer transport: Bearer secret-registration-token"));
    let response: unknown;
    try { await f.svc.start(input, origin); } catch (error) {
      response = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(response).toMatchObject({ code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(JSON.stringify(response)).not.toContain("secret-registration-token");
    await expect(f.restart().start(input, origin)).rejects.toMatchObject({
      response: { code: "MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED" },
    });
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "registration"))
      .toHaveLength(1);
    expect(f.prisma.mcpOAuthUpstreamClient.create).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
  });

  it("exchanges once with exact persisted client and refuses replay with another tenant", async () => {
    const f = fixture();
    const { state } = await f.svc.start(input, origin);
    await expect(f.svc.exchange("zita-code", state, origin)).resolves.toMatchObject({
      idToken: "signed-issuer-jwt", accessToken: "short-lived-userinfo-access", record: {
        tenantId: tenant, resource: input.resource, upstreamClientId,
      },
    });
    await expect(f.svc.exchange("zita-code", state, origin)).rejects.toThrow("Expired MCP identity OAuth state");
    await expect(f.svc.start({
      ...input, tenantId: otherTenant,
    }, origin)).rejects.toThrow("MCP resource audience mismatch");
  });

  it.each([
    "https://evil.example.test/oauth/v2/token",
    "http://zitadel.example.test/oauth/v2/token",
    "https://zitadel.example.test/admin/privileged",
    "https://zitadel.example.test/oauth/v2/token?leak=true",
    "https://client:password@zitadel.example.test/oauth/v2/token",
    "invalid-token-url",
  ])("rejects untrusted token endpoint without consuming pending state (%s)", async (endpoint) => {
    const f = fixture();
    const { state } = await f.svc.start(input, origin);
    f.transport.mockClear();
    f.oidc.getDiscovery.mockResolvedValueOnce({ ...discovery, tokenEndpoint: endpoint });
    await expect(f.svc.exchange("one-time-authorization-code", state, origin))
      .rejects.toThrow("Untrusted ZITADEL token endpoint");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.logins.size).toBe(1);
    // Corrected discovery can resume with the original, still-unused state.
    await expect(f.svc.exchange("one-time-authorization-code", state, origin))
      .resolves.toMatchObject({ idToken: "signed-issuer-jwt" });
    expect(f.logins.size).toBe(0);
  });

  it("does not consume OAuth state on foreign or invalid callback origins", async () => {
    const f = fixture();
    const { state } = await f.svc.start(input, origin);
    f.transport.mockClear();
    await expect(f.svc.exchange("fresh-code", state, "https://attacker.example.test"))
      .rejects.toThrow("MCP identity client or resource mismatch");
    await expect(f.svc.exchange("fresh-code", state, "http://rp.example.test"))
      .rejects.toThrow("Canonical public RP origin is required");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.logins.size).toBe(1);
    await expect(f.svc.exchange("fresh-code", state, origin))
      .resolves.toMatchObject({ idToken: "signed-issuer-jwt" });
    expect(f.logins.size).toBe(0);
  });

  it("does not consume OAuth state after upstream identity-client binding changes", async () => {
    const f = fixture();
    const { state } = await f.svc.start(input, origin);
    f.transport.mockClear();
    f.prisma.mcpOAuthUpstreamClient.findUnique.mockResolvedValueOnce({
      tenantId: tenant, clientId: "340396026519785526",
    });
    await expect(f.svc.exchange("fresh-code", state, origin))
      .rejects.toThrow("MCP identity client or resource mismatch");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.logins.size).toBe(1);
    await expect(f.svc.exchange("fresh-code", state, origin))
      .resolves.toMatchObject({ idToken: "signed-issuer-jwt" });
  });

  it("classifies missing upstream authorization requests without exposing OAuth secrets", async () => {
    const f = fixture();
    const { state } = await f.svc.start(input, origin);
    f.transport.mockImplementation((_, stage) => {
      if (stage === "code-exchange") return Promise.resolve(new Response(JSON.stringify({
        error: "invalid_request", error_description: "Errors.AuthRequest.NotFound",
        debug: "authorization_code=SECRET-CODE",
      }), { status: 400 }));
      throw new Error("Unexpected stage");
    });
    let response: unknown;
    try {
      await f.svc.exchange("SECRET-CODE", state, origin);
    } catch (error) {
      response = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(response).toMatchObject({ code: "MCP_IDENTITY_AUTH_REQUEST_NOT_FOUND" });
    expect(JSON.stringify(response)).not.toContain("SECRET-CODE");
    expect(JSON.stringify(response)).not.toContain(state);
    expect(JSON.stringify(response)).not.toContain("Errors.AuthRequest.NotFound");
  });

  it("rejects wrong origin, missing state and stale signed state before token request", async () => {
    const f = fixture();
    await expect(f.svc.start(input, "https://attacker.example.test"))
      .rejects.toThrow("MCP resource audience mismatch");
    const { state } = await f.svc.start(input, origin);
    await expect(f.svc.exchange("code", "forged", origin))
      .rejects.toThrow("Invalid MCP identity OAuth callback");
    const login = [...f.logins.values()][0];
    login.expiresAt = new Date(Date.now() - 60_000);
    await expect(f.svc.exchange("code", state, origin))
      .rejects.toThrow("Expired MCP identity OAuth state");
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "code-exchange"))
      .toHaveLength(0);
  });
});
