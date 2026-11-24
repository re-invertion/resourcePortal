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
  const prisma = {
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
  return { svc, prisma, encryption, transport, logins };
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
    const login = [...f.logins.values()][0];
    expect(login.resource).toBe(input.resource);
    expect(login.tenantId).toBe(tenant);
    expect(login.clientState).toBe(input.clientState);
    expect(login.verifierCipher).toMatch(/^sealed-/);
    expect(login.verifierCipher).not.toContain(flow.state);
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
    expect(f.prisma.mcpOAuthUpstreamLogin.create).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.filter(([, stage]) => stage === "registration"))
      .toHaveLength(1);
  });

  it("never reports two successful identity logins when concurrent DCR registration leaves one client orphaned", async () => {
    const f = fixture();
    const differentClient = "340396026519785525";
    const created: string[] = [];
    f.prisma.mcpOAuthUpstreamClient.create.mockImplementation((args: {
      data: { tenantId: string; clientId: string };
    }) => {
      if (created.length) return Promise.reject(new Error("P2002 unique client binding"));
      created.push(args.data.clientId);
      return Promise.resolve(args.data);
    });
    let issued = 0;
    f.transport.mockImplementation((_, stage) => {
      expect(stage).toBe("registration");
      const registrationId = issued++ === 0 ? upstreamClientId : differentClient;
      return Promise.resolve(new Response(JSON.stringify({
        client_id: registrationId,
        redirect_uris: [`${origin}/api/mcp/oauth/upstream/callback`],
        token_endpoint_auth_method: "none",
      }), { status: 201 }));
    });
    const results = await Promise.allSettled([
      f.svc.start(input, origin), f.svc.start(input, origin),
    ]);
    const successes = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof f.svc.start>>> =>
      r.status === "fulfilled");
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(issued).toBe(2);
    expect(created).toEqual([upstreamClientId]);
    const publicError = (failures[0].reason as { getResponse: () => unknown }).getResponse();
    expect(publicError).toMatchObject({
      code: "MCP_IDENTITY_DCR_PARTIAL_REGISTRATION", clientId: differentClient,
    });
    expect(f.logins.size).toBe(1);
    expect(f.prisma.mcpOAuthUpstreamClient.create).toHaveBeenCalledTimes(2);
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
