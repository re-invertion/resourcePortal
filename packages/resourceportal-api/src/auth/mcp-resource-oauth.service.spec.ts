import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthSessionService } from "./auth-session.service";
import { McpOAuthProtocolError, McpResourceOAuthService } from "./mcp-resource-oauth.service";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const clientCallback = "https://chatgpt.com/connector/oauth/connector123";
const resource = (tenant: string) => `https://rp.example.test/api/tenants/${tenant}/mcp`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const verifier = "A".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function fixture(enabled = true) {
  const clients = new Map<string, Record<string, unknown>>();
  const codes = new Map<string, Record<string, unknown>>();
  const pendingConsents = new Map<string, Record<string, unknown>>();
  const grants = new Map<string, Record<string, unknown>>();
  const spent = new Map<string, string>();
  let counter = 0;
  const prisma = {
    mcpOAuthClient: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const client = { ...data, createdAt: new Date(), revokedAt: null };
        clients.set(data.id as string, client);
        return client;
      }),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        clients.get(where.id) ?? null),
    },
    mcpOAuthPendingConsent: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        pendingConsents.set(data.id as string, { ...data });
        return data;
      }),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        pendingConsents.get(where.id) ?? null),
      deleteMany: vi.fn(({ where }: { where: {
        id: string; userId: string; expiresAt: { gt: Date };
      } }) => {
        const row = pendingConsents.get(where.id);
        if (!row || row.userId !== where.userId ||
            (row.expiresAt as Date).getTime() <= where.expiresAt.gt.getTime()) return { count: 0 };
        pendingConsents.delete(where.id);
        return { count: 1 };
      }),
    },
    mcpOAuthCode: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        codes.set(data.codeHash as string, { ...data });
        return data;
      }),
      findUnique: vi.fn(({ where }: { where: { codeHash: string } }) =>
        codes.get(where.codeHash) ?? null),
      deleteMany: vi.fn(({ where }: { where: { codeHash: string; expiresAt: { gt: Date } } }) => {
        const row = codes.get(where.codeHash);
        if (!row || (row.expiresAt as Date).getTime() <= where.expiresAt.gt.getTime()) {
          return { count: 0 };
        }
        codes.delete(where.codeHash);
        return { count: 1 };
      }),
    },
    mcpOAuthBrowserSession: {
      findUnique: vi.fn(),
    },
    mcpOAuthSpentRefreshToken: {
      create: vi.fn(({ data }: { data: { tokenHash: string; grantId: string } }) => {
        if (spent.has(data.tokenHash)) throw new Error("Duplicate spent refresh token");
        spent.set(data.tokenHash, data.grantId);
        return data;
      }),
      findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) => {
        const grantId = spent.get(where.tokenHash);
        if (!grantId) return null;
        return {
          grantId, tokenHash: where.tokenHash,
          grant: { clientId: grants.get(grantId)?.clientId },
        };
      }),
    },
    mcpOAuthGrant: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = `grant-${++counter}`;
        grants.set(id, { id, ...data, revokedAt: null });
        return grants.get(id);
      }),
      findUnique: vi.fn(({ where }: {
        where: { refreshTokenHash?: string; accessTokenHash?: string };
      }) => {
        const row = [...grants.values()].find(entry =>
          (where.refreshTokenHash && entry.refreshTokenHash === where.refreshTokenHash) ||
          (where.accessTokenHash && entry.accessTokenHash === where.accessTokenHash));
        if (!row) return null;
        return {
          ...row,
          user: {
            id: userId, status: UserStatus.Active,
            email: "user@example.test", displayName: "User",
          },
          client: clients.get(row.clientId as string),
        };
      }),
      updateMany: vi.fn(({ where, data }: {
        where: Record<string, unknown>; data: Record<string, unknown>;
      }) => {
        const entries = [...grants.values()].filter(entry =>
          Object.entries(where).every(([key, value]) => {
            if (key === "refreshExpiresAt") {
              return (entry.refreshExpiresAt as Date).getTime() > (value as { gt: Date }).gt.getTime();
            }
            return entry[key] === value;
          }));
        for (const row of entries) Object.assign(row, data);
        return { count: entries.length };
      }),
    },
  };
  // The real Prisma interactive transaction atomically commits the
  // refresh hash swap and spent-token insert (or neither operation).
  Object.assign(prisma, {
    $transaction: vi.fn((callback: (tx: typeof prisma) => Promise<boolean>) =>
      callback(prisma)),
  });
  const config = {
    get: vi.fn((key: string) => ({
      RP_MCP_RESOURCE_OAUTH_ENABLED: enabled ? "true" : "false",
      PUBLIC_API_URL: "https://rp.example.test",
    })[key as "RP_MCP_RESOURCE_OAUTH_ENABLED" | "PUBLIC_API_URL"]),
  };
  const sessions = { getSessionIdFromRequest: vi.fn(), authenticateSession: vi.fn() };
  return {
    service: new McpResourceOAuthService(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
      sessions as unknown as AuthSessionService,
    ),
    clients, codes, pendingConsents, grants, spent, prisma, config, sessions,
  };
}

afterEach(() => vi.restoreAllMocks());

async function registered(f: ReturnType<typeof fixture>) {
  const registration = await f.service.registerClient({
    redirect_uris: [callback, clientCallback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  return registration.client_id;
}
async function issued(f: ReturnType<typeof fixture>, tenant = a, scope = "mcp offline_access") {
  const clientId = await registered(f);
  const code = await f.service.issueCode({
    user: {
      id: userId, email: "user@example.test",
      displayName: "User", status: UserStatus.Active,
    },
    tenantId: tenant, clientId, redirectUri: callback, challenge, scope,
  });
  const input: Record<string, unknown> = {
    client_id: clientId, redirect_uri: callback, code, code_verifier: verifier,
    resource: resource(tenant), grant_type: "authorization_code",
  };
  const inspected = await f.service.inspectCode(input);
  const tokens = await f.service.redeemCode(input, inspected.codeHash);
  return { clientId, code, input, tokens };
}

describe("RP tenant MCP OAuth resource isolation (#442)", () => {
  it("publishes only a canonical HTTPS issuer and rejects spoofed tenant resources", () => {
    const { service } = fixture();
    expect(service.getIssuer()).toBe("https://rp.example.test/api/mcp/oauth");
    expect(service.resourceForTenant(a)).toBe(resource(a));
    expect(service.tenantFromResource(resource(a))).toBe(a);
    for (const invalid of [
      resource(b) + "?client_id=any", "https://evil.example.test/api/tenants/" + a + "/mcp",
      "https://rp.example.test/api/platform/mcp",
      resource(a).replace("https:", "http:"),
      resource(a).replace(a, "../" + a), "//evil.example.test/api/tenants/" + a + "/mcp",
    ]) {
      expect(() => service.tenantFromResource(invalid)).toThrow();
    }
  });

  it("requires explicit feature enablement and never exposes its AS when disabled", async () => {
    const { service } = fixture(false);
    expect(() => service.getIssuer()).toThrow("disabled");
    await expect(service.registerClient({ redirect_uris: [callback] })).rejects.toThrow("disabled");
  });

  it("only registers HTTPS callback endpoints controlled by ChatGPT", async () => {
    const f = fixture();
    await expect(f.service.registerClient({
      redirect_uris: [callback, "https://attacker.test/callback"],
    })).rejects.toBeInstanceOf(McpOAuthProtocolError);
    await expect(f.service.registerClient({
      redirect_uris: [callback, callback],
    })).rejects.toThrow("invalid_client_metadata");
    await expect(f.service.registerClient({
      redirect_uris: [callback], grant_types: ["client_credentials"],
    })).rejects.toThrow("invalid_client_metadata");
    const id = await registered(f);
    await expect(f.service.requireClient(id, callback)).resolves.toMatchObject({
      id, redirectUris: [callback, clientCallback],
    });
    await expect(f.service.requireClient(id, "https://evil.test/callback")).rejects.toThrow();
    await expect(f.service.requireClient("unregistered-id")).rejects.toThrow("invalid_client");
  });

  it("requires code + PKCE S256 + resource + trusted redirect for authorization", async () => {
    const f = fixture();
    const id = await registered(f);
    const query = {
      response_type: "code", client_id: id, redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: "S256",
      resource: resource(a), scope: "mcp offline_access", state: "authenticated-state",
    };
    expect(f.service.parseAuthorization(query)).toMatchObject({ tenantId: a, clientId: id });
    expect(() => f.service.parseAuthorization({ ...query, resource: resource(b) })).not.toThrow();
    expect(() => f.service.parseAuthorization({ ...query, code_challenge_method: "plain" })).toThrow();
    expect(() => f.service.parseAuthorization({ ...query, state: "" })).toThrow();
    expect(() => f.service.parseAuthorization({ ...query, scope: "mcp admin" })).toThrow();
    expect(() => f.service.parseAuthorization({ ...query, scope: "offline_access" })).toThrow("invalid_scope");
    expect(() => f.service.parseAuthorization({ ...query, scope: "openid" })).toThrow("invalid_scope");
    expect(() => f.service.parseAuthorization({ ...query, redirect_uri: "https://evil.test" })).toThrow();
  });

  it("isolates the MCP-only signed browser proof by tenant even before consent", async () => {
    const f = fixture();
    const session = "I".repeat(43);
    f.prisma.mcpOAuthBrowserSession.findUnique.mockResolvedValue({
      tenantId: a, userId, authenticatedIdpId: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: userId, email: "mcp-only@example.test", displayName: "MCP-only",
        status: UserStatus.Active,
      },
    });
    const request = {
      cookies: { rp_mcp_identity_session: "signed-identity-proof" },
      unsignCookie: vi.fn().mockReturnValue({ valid: true, value: session }),
    } as unknown as import("fastify").FastifyRequest;
    await expect(f.service.browserUser(request, a)).resolves.toMatchObject({
      id: userId,
    });
    await expect(f.service.browserUser(request, b)).resolves.toBeNull();
    // No RP Web session is needed or created during this check.
    expect(f.sessions.authenticateSession).not.toHaveBeenCalled();
    expect(f.prisma.mcpOAuthBrowserSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionHash: sha(session) },
      }),
    );
    request.unsignCookie = vi.fn().mockReturnValue({ valid: false });
    await expect(f.service.browserUser(request, a)).resolves.toBeNull();
  });

  it("binds opaque tokens to one MCP tenant even when the subject can access others", async () => {
    const f = fixture();
    const { tokens } = await issued(f, a);
    expect(tokens.access_token).toMatch(/^rpoat_v1_/);
    expect(tokens.refresh_token).toMatch(/^rport_v1_/);
    expect(f.grants.size).toBe(1);
    const stored = [...f.grants.values()][0];
    expect(stored.accessTokenHash).toBe(sha(tokens.access_token));
    expect(stored.accessTokenHash).not.toBe(tokens.access_token);
    await expect(f.service.authenticateAccessToken(tokens.access_token, a))
      .resolves.toMatchObject({ id: userId, status: UserStatus.Active });
    await expect(f.service.authenticateAccessToken(tokens.access_token, b))
      .rejects.toThrow("invalid resource audience");
    await expect(f.service.authenticateAccessToken("not-a-token", a)).rejects.toThrow();
    stored.accessExpiresAt = new Date(Date.now() - 1000);
    await expect(f.service.authenticateAccessToken(tokens.access_token, a))
      .rejects.toThrow("invalid resource audience");
  });

  it("requires explicit one-time consent from the same RP user", async () => {
    const f = fixture();
    const clientId = await registered(f);
    const nonce = await f.service.beginConsent({
      clientId, tenantId: a, userId, redirectUri: callback,
      challenge, scope: "mcp offline_access", state: "some-state",
    });
    expect(nonce).toMatch(/^rpocons_/);
    expect(f.pendingConsents.size).toBe(1);
    const pending = await f.service.inspectConsent(nonce);
    expect(pending).toMatchObject({ userId, tenantId: a, clientId, state: "some-state" });
    await expect(f.service.consumeConsent(nonce, b)).rejects.toThrow("invalid_request");
    await expect(f.service.consumeConsent(nonce, userId)).resolves.toMatchObject({
      userId, tenantId: a,
    });
    await expect(f.service.consumeConsent(nonce, userId)).rejects.toThrow("invalid_request");
    expect(f.pendingConsents.size).toBe(0);
  });

  it("never lets one authorization code be redeemed twice", async () => {
    const f = fixture();
    const { input, code } = await issued(f);
    await expect(f.service.inspectCode(input)).rejects.toThrow("invalid_grant");
    await expect(f.service.inspectCode({ ...input, code: code + "junk" })).rejects.toThrow();
    expect(f.grants.size).toBe(1);
  });

  it("rejects wrong PKCE verifier and token exchange to another tenant", async () => {
    const f = fixture();
    const clientId = await registered(f);
    const code = await f.service.issueCode({
      user: { id: userId, email: "u@test", displayName: "User", status: UserStatus.Active },
      tenantId: a, clientId, redirectUri: callback, challenge, scope: "mcp",
    });
    const input = {
      client_id: clientId, redirect_uri: callback, code,
      code_verifier: verifier, resource: resource(a),
    };
    await expect(f.service.inspectCode({ ...input, code_verifier: "B".repeat(64) }))
      .rejects.toThrow("invalid_grant");
    await expect(f.service.inspectCode({ ...input, resource: resource(b) }))
      .rejects.toThrow("invalid_grant");
    await expect(f.service.inspectCode({ ...input, client_id: "rpocli_1234" }))
      .rejects.toThrow("invalid_client");
    expect(f.codes.size).toBe(1);
  });

  it("atomically rotates refresh tokens and never retargets the MCP resource", async () => {
    const f = fixture();
    const { clientId, tokens } = await issued(f, a);
    const input = {
      client_id: clientId, refresh_token: tokens.refresh_token, resource: resource(a),
      grant_type: "refresh_token",
    };
    const inspect = await f.service.inspectRefresh(input);
    await expect(f.service.inspectRefresh({ ...input, resource: resource(b) }))
      .rejects.toThrow("invalid_target");
    await expect(f.service.inspectRefresh({
      client_id: clientId, refresh_token: tokens.refresh_token,
    })).resolves.toMatchObject({ tenantId: a, resource: resource(a) });
    const rotated = await f.service.rotateRefresh(input, inspect.id);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await expect(f.service.authenticateAccessToken(tokens.access_token, a)).rejects.toThrow();
    await expect(f.service.authenticateAccessToken(rotated.access_token, a)).resolves.toHaveProperty("id", userId);
    await expect(f.service.authenticateAccessToken(rotated.access_token, b)).rejects.toThrow();
    expect(f.spent.get(sha(tokens.refresh_token!))).toBe(inspect.id);
    // Reusing the spent refresh token now revokes the WHOLE active successor
    // instead of leaving it available for a thief.
    await expect(f.service.inspectRefresh(input)).rejects.toThrow("invalid_grant");
    await expect(f.service.inspectRefresh({
      ...input, refresh_token: rotated.refresh_token,
    })).rejects.toThrow("invalid_grant");
    await expect(f.service.authenticateAccessToken(rotated.access_token, a)).rejects.toThrow();
    await f.service.revoke(rotated.refresh_token, clientId); // idempotent after replay
  });

  it("retains every rotated hash and revokes the latest successor after a spent ancestor is replayed", async () => {
    const f = fixture();
    const { clientId, tokens } = await issued(f, a);
    const firstInput = { client_id: clientId, refresh_token: tokens.refresh_token,
      resource: resource(a), grant_type: "refresh_token" };
    const first = await f.service.inspectRefresh(firstInput);
    const successor1 = await f.service.rotateRefresh(firstInput, first.id);
    const secondInput = { ...firstInput, refresh_token: successor1.refresh_token };
    const second = await f.service.inspectRefresh(secondInput);
    const successor2 = await f.service.rotateRefresh(secondInput, second.id);
    await expect(f.service.authenticateAccessToken(successor2.access_token, a))
      .resolves.toHaveProperty("id", userId);
    expect(f.spent.get(sha(tokens.refresh_token!))).toBe(first.id);
    expect(f.spent.get(sha(successor1.refresh_token))).toBe(first.id);
    expect([...f.spent.keys()]).not.toContain(tokens.refresh_token);
    await expect(f.service.inspectRefresh(firstInput)).rejects.toThrow("invalid_grant");
    await expect(f.service.authenticateAccessToken(successor2.access_token, a)).rejects.toThrow();
    await expect(f.service.inspectRefresh({ ...firstInput,
      refresh_token: successor2.refresh_token })).rejects.toThrow("invalid_grant");
  });

  it("does not let a different client's token error revoke the original client's grant", async () => {
    const f = fixture();
    const { clientId, tokens } = await issued(f, a);
    const input = { client_id: clientId, refresh_token: tokens.refresh_token,
      resource: resource(a), grant_type: "refresh_token" };
    const grant = await f.service.inspectRefresh(input);
    const rotated = await f.service.rotateRefresh(input, grant.id);
    const otherClientId = await registered(f);
    await expect(f.service.inspectRefresh({
      ...input, client_id: otherClientId,
    })).rejects.toThrow("invalid_grant");
    await expect(f.service.authenticateAccessToken(rotated.access_token, a))
      .resolves.toHaveProperty("id", userId);
  });

  it("revoke with an already-spent refresh token disconnects its active successor", async () => {
    const f = fixture();
    const { clientId, tokens } = await issued(f, a);
    const input = { client_id: clientId, refresh_token: tokens.refresh_token,
      resource: resource(a), grant_type: "refresh_token" };
    const grant = await f.service.inspectRefresh(input);
    const rotated = await f.service.rotateRefresh(input, grant.id);
    await expect(f.service.authenticateAccessToken(rotated.access_token, a))
      .resolves.toHaveProperty("id", userId);
    await f.service.revoke(tokens.refresh_token, clientId);
    await expect(f.service.authenticateAccessToken(rotated.access_token, a))
      .rejects.toThrow();
    await f.service.revoke(tokens.refresh_token, clientId); // idempotent
  });

  it("revokes the grant when simultaneous attempts race with the same old refresh token", async () => {
    const f = fixture();
    const { clientId, tokens } = await issued(f, a);
    const input = { client_id: clientId, refresh_token: tokens.refresh_token,
      resource: resource(a), grant_type: "refresh_token" };
    const grant = await f.service.inspectRefresh(input);
    const results = await Promise.allSettled([
      f.service.rotateRefresh(input, grant.id),
      f.service.rotateRefresh(input, grant.id),
    ]);
    const accepted = results.filter(x => x.status === "fulfilled");
    const denied = results.filter(x => x.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const grantRow = f.grants.get(grant.id);
    expect(grantRow?.revokedAt).toBeInstanceOf(Date);
    expect(f.spent.get(sha(tokens.refresh_token!))).toBe(grant.id);
  });

  it("never issues refresh tokens without offline_access", async () => {
    const f = fixture();
    const { tokens } = await issued(f, a, "mcp");
    expect(tokens).not.toHaveProperty("refresh_token");
  });
});
