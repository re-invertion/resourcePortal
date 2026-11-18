import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma/prisma.service";
import { isChatGptOAuthRedirect } from "../app-consumers/mcp-dcr-client-verifier.service";
import { AuthSessionService } from "./auth-session.service";
import { AuthenticatedUser } from "./types";

/** Deliberately opaque. Tokens issued by RP never transit upstream to ZITADEL
 * or a tenant workload; the database records their exact intended MCP resource.
 * A ZITADEL token must never be mistaken for a RP OAuth resource token.
 */
const accessPrefix = "rpoat_v1_";
const refreshPrefix = "rport_v1_";
const codePrefix = "rpoc_v1_";
const accessTtlSeconds = 900;
const refreshTtlSeconds = 30 * 24 * 3600;
const scopeSet = new Set(["mcp", "offline_access"]);
const tenantPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;

export class McpOAuthProtocolError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function randomToken(prefix: string) {
  return prefix + randomBytes(32).toString("base64url");
}
function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function allowedScope(value: unknown): string {
  if (value === undefined || value === "") return "mcp";
  if (typeof value !== "string" || value.length > 160) {
    throw new McpOAuthProtocolError("invalid_scope");
  }
  const parts = value.split(" ").filter(Boolean);
  if (!parts.includes("mcp") || parts.some(part => !scopeSet.has(part))) {
    throw new McpOAuthProtocolError("invalid_scope");
  }
  return [...new Set(parts)].join(" ");
}

@Injectable()
export class McpResourceOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
  ) {}

  isEnabled() {
    const mode = this.config.get<string>("RP_MCP_RESOURCE_OAUTH_ENABLED");
    if (mode === "true") return true;
    return mode === "auto" &&
      this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") === "true" &&
      this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") === "true";
  }

  requireEnabled() {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException("RP resource-bound MCP OAuth is disabled");
    }
  }

  getOrigin() {
    this.requireEnabled();
    const raw = this.config.get<string>("PUBLIC_API_URL") ?? "";
    let url: URL;
    try { url = new URL(raw); } catch {
      throw new ServiceUnavailableException("PUBLIC_API_URL must be a canonical HTTPS origin");
    }
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new ServiceUnavailableException("PUBLIC_API_URL must be a canonical HTTPS origin");
    }
    return url.origin;
  }

  getIssuer() { return `${this.getOrigin()}/api/mcp/oauth`; }

  resourceForTenant(tenantId: string) {
    if (!tenantPattern.test(tenantId)) throw new McpOAuthProtocolError("invalid_target");
    return `${this.getOrigin()}/api/tenants/${tenantId}/mcp`;
  }

  tenantFromResource(raw: unknown) {
    if (typeof raw !== "string" || raw.length > 500) {
      throw new McpOAuthProtocolError("invalid_target");
    }
    let url: URL;
    try { url = new URL(raw); } catch {
      throw new McpOAuthProtocolError("invalid_target");
    }
    const match = /^\/api\/tenants\/([0-9a-f-]{36})\/mcp$/.exec(url.pathname);
    if (!match || !tenantPattern.test(match[1]) ||
        raw !== this.resourceForTenant(match[1])) {
      throw new McpOAuthProtocolError("invalid_target");
    }
    return match[1];
  }

  async registerClient(metadata: unknown) {
    this.requireEnabled();
    if (!isRecord(metadata)) throw new McpOAuthProtocolError("invalid_client_metadata");
    const redirects = metadata.redirect_uris;
    const grants = metadata.grant_types;
    const responses = metadata.response_types;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 4 ||
        !redirects.every(isChatGptOAuthRedirect) ||
        new Set(redirects).size !== redirects.length ||
        (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== "none") ||
        (grants !== undefined && (!Array.isArray(grants) ||
          grants.some(x => x !== "authorization_code" && x !== "refresh_token") ||
          !grants.includes("authorization_code"))) ||
        (responses !== undefined && (!Array.isArray(responses) ||
          responses.length !== 1 || responses[0] !== "code"))) {
      throw new McpOAuthProtocolError("invalid_client_metadata");
    }
    const clientId = randomToken("rpocli_");
    const client = await this.prisma.mcpOAuthClient.create({
      data: { id: clientId, redirectUris: redirects as string[] },
    });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  async requireClient(clientId: unknown, redirectUri?: unknown) {
    this.requireEnabled();
    if (typeof clientId !== "string" || !/^rpocli_[A-Za-z0-9_-]{43}$/.test(clientId)) {
      throw new McpOAuthProtocolError("invalid_client", 401);
    }
    const client = await this.prisma.mcpOAuthClient.findUnique({ where: { id: clientId } });
    if (!client || client.revokedAt || !client.redirectUris.length ||
        !client.redirectUris.every(isChatGptOAuthRedirect)) {
      throw new McpOAuthProtocolError("invalid_client", 401);
    }
    if (redirectUri !== undefined && (typeof redirectUri !== "string" ||
        !client.redirectUris.includes(redirectUri))) {
      throw new McpOAuthProtocolError("invalid_request");
    }
    return client;
  }

  async browserUser(request: FastifyRequest, tenantId?: string): Promise<AuthenticatedUser | null> {
    // A tenant-specific identity-only session takes priority over a
    // potentially unrelated logged-in RP Web user. The explicit OAuth
    // redirect authenticates the user who approved the connector consent.
    // A user permitted to access tenant MCP may deliberately NOT have any
    // native RP Web grant. The dedicated upstream OIDC callback provides a
    // short-lived, signed cookie proof usable only for that exact tenant.
    if (tenantId && typeof request.unsignCookie === "function" &&
        request.cookies.rp_mcp_identity_session) {
      const proof = await this.lookupMcpIdentityCookie(request, tenantId);
      if (proof) return proof;
    }
    const sessionId = this.sessions.getSessionIdFromRequest(request);
    if (!sessionId) return null;
    try { return await this.sessions.authenticateSession(sessionId); }
    catch (error) {
      if (error instanceof UnauthorizedException) return null;
      throw error;
    }
  }

  private async lookupMcpIdentityCookie(request: FastifyRequest, tenantId: string) {
    const cookie = request.cookies.rp_mcp_identity_session;
    if (!cookie) return null;
    const unsigned = request.unsignCookie(cookie);
    const token = unsigned.valid ? unsigned.value : undefined;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const proof = await this.prisma.mcpOAuthBrowserSession.findUnique({
      where: { sessionHash: hash(token) },
      include: {
        user: { select: { id: true, email: true, displayName: true, status: true } },
      },
    });
    if (!proof || proof.tenantId !== tenantId ||
        proof.expiresAt.getTime() <= Date.now() ||
        proof.user.status !== UserStatus.Active) return null;
    return {
      ...proof.user,
      ...(proof.authenticatedIdpId ?
        { authenticatedIdpId: proof.authenticatedIdpId } : {}),
    };
  }

  parseAuthorization(query: unknown) {
    this.requireEnabled();
    if (!isRecord(query)) throw new McpOAuthProtocolError("invalid_request");
    const clientId = stringParam(query.client_id);
    const redirectUri = stringParam(query.redirect_uri);
    const state = stringParam(query.state);
    const challenge = stringParam(query.code_challenge);
    const resource = stringParam(query.resource);
    if (query.response_type !== "code" || query.code_challenge_method !== "S256" ||
        !challengePattern.test(challenge) || state.length < 8 || state.length > 256 ||
        /[^\x21-\x7e]/.test(state) || redirectUri.length > 500 ||
        !isChatGptOAuthRedirect(redirectUri)) {
      throw new McpOAuthProtocolError("invalid_request");
    }
    const tenantId = this.tenantFromResource(resource);
    return { tenantId, clientId, redirectUri, state, challenge, resource, scope: allowedScope(query.scope) };
  }

  async beginConsent(input: {
    userId: string; tenantId: string; clientId: string;
    redirectUri: string; challenge: string; scope: string; state: string;
  }) {
    await this.requireClient(input.clientId, input.redirectUri);
    this.resourceForTenant(input.tenantId);
    const nonce = randomToken("rpocons_");
    await this.prisma.mcpOAuthPendingConsent.create({ data: {
      id: hash(nonce), userId: input.userId, tenantId: input.tenantId,
      clientId: input.clientId, redirectUri: input.redirectUri,
      codeChallenge: input.challenge, scope: input.scope, state: input.state,
      expiresAt: new Date(Date.now() + 600_000),
    } });
    return nonce;
  }

  async inspectConsent(nonce: unknown) {
    this.requireEnabled();
    if (typeof nonce !== "string" || !/^rpocons_[A-Za-z0-9_-]{43}$/.test(nonce)) {
      throw new McpOAuthProtocolError("invalid_request");
    }
    const row = await this.prisma.mcpOAuthPendingConsent.findUnique({
      where: { id: hash(nonce) },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new McpOAuthProtocolError("invalid_request");
    }
    return row;
  }

  async consumeConsent(nonce: string, userId: string) {
    const pending = await this.inspectConsent(nonce);
    if (pending.userId !== userId) throw new McpOAuthProtocolError("invalid_request");
    const taken = await this.prisma.mcpOAuthPendingConsent.deleteMany({
      where: { id: pending.id, userId, expiresAt: { gt: new Date() } },
    });
    if (taken.count !== 1) throw new McpOAuthProtocolError("invalid_request");
    return pending;
  }

  async issueCode(input: {
    tenantId: string; clientId: string; redirectUri: string; challenge: string;
    scope: string; user: AuthenticatedUser;
  }) {
    const resource = this.resourceForTenant(input.tenantId);
    await this.requireClient(input.clientId, input.redirectUri);
    const code = randomToken(codePrefix);
    await this.prisma.mcpOAuthCode.create({ data: {
      codeHash: hash(code), clientId: input.clientId, userId: input.user.id,
      tenantId: input.tenantId, resource, redirectUri: input.redirectUri,
      codeChallenge: input.challenge, authenticatedIdpId: input.user.authenticatedIdpId ?? null,
      scope: input.scope, expiresAt: new Date(Date.now() + 300_000),
    } });
    return code;
  }

  async inspectCode(input: Record<string, unknown>) {
    this.requireEnabled();
    const code = stringParam(input.code);
    const clientId = stringParam(input.client_id);
    const redirectUri = stringParam(input.redirect_uri);
    const verifier = stringParam(input.code_verifier);
    const resource = stringParam(input.resource);
    if (!code.startsWith(codePrefix) || code.length > 120 ||
        !verifierPattern.test(verifier) || !resource || !redirectUri) {
      throw new McpOAuthProtocolError("invalid_grant");
    }
    await this.requireClient(clientId, redirectUri);
    const row = await this.prisma.mcpOAuthCode.findUnique({ where: { codeHash: hash(code) } });
    const expected = createHash("sha256").update(verifier).digest("base64url");
    if (!row || row.clientId !== clientId || row.redirectUri !== redirectUri ||
        row.resource !== resource || row.expiresAt.getTime() <= Date.now() ||
        row.codeChallenge.length !== expected.length ||
        !timingSafeEqual(Buffer.from(row.codeChallenge), Buffer.from(expected))) {
      throw new McpOAuthProtocolError("invalid_grant");
    }
    return row;
  }

  async redeemCode(input: Record<string, unknown>, codeHash: string) {
    const now = Date.now();
    const row = await this.inspectCode(input);
    if (row.codeHash !== codeHash) throw new McpOAuthProtocolError("invalid_grant");
    const consumed = await this.prisma.mcpOAuthCode.deleteMany({
      where: { codeHash: row.codeHash, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) throw new McpOAuthProtocolError("invalid_grant");
    const accessToken = randomToken(accessPrefix);
    const canRefresh = row.scope.split(" ").includes("offline_access");
    const refreshToken = canRefresh ? randomToken(refreshPrefix) : undefined;
    await this.prisma.mcpOAuthGrant.create({ data: {
      clientId: row.clientId, userId: row.userId, tenantId: row.tenantId,
      resource: row.resource, scope: row.scope,
      authenticatedIdpId: row.authenticatedIdpId,
      accessTokenHash: hash(accessToken),
      refreshTokenHash: refreshToken ? hash(refreshToken) : null,
      accessExpiresAt: new Date(now + accessTtlSeconds * 1000),
      refreshExpiresAt: new Date(now + refreshTtlSeconds * 1000),
    } });
    return {
      access_token: accessToken, token_type: "Bearer", expires_in: accessTtlSeconds,
      scope: row.scope, ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  async inspectRefresh(input: Record<string, unknown>) {
    this.requireEnabled();
    const token = stringParam(input.refresh_token);
    const clientId = stringParam(input.client_id);
    if (!token.startsWith(refreshPrefix) || token.length > 120) {
      throw new McpOAuthProtocolError("invalid_grant");
    }
    await this.requireClient(clientId);
    const tokenHash = hash(token);
    const row = await this.prisma.mcpOAuthGrant.findUnique({
      where: { refreshTokenHash: tokenHash },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!row) {
      // A rotated token is no longer indexed on the active grant. Retain its
      // hash so reuse can invalidate the ENTIRE successor grant, not merely
      // reject the old secret and leave a stolen successor refreshable.
      const spent = await this.prisma.mcpOAuthSpentRefreshToken.findUnique({
        where: { tokenHash },
        include: { grant: { select: { clientId: true } } },
      });
      if (spent?.grant.clientId === clientId) {
        await this.revokeRefreshLineage(spent.grantId, clientId);
      }
      throw new McpOAuthProtocolError("invalid_grant");
    }
    if (row.clientId !== clientId || row.revokedAt ||
        row.refreshExpiresAt.getTime() <= Date.now() || row.user.status !== UserStatus.Active) {
      throw new McpOAuthProtocolError("invalid_grant");
    }
    // A refresh without resource inherits the original grant's audience.
    // An explicit different resource is always rejected (RFC 8707).
    if (input.resource !== undefined && input.resource !== row.resource) {
      throw new McpOAuthProtocolError("invalid_target");
    }
    return row;
  }

  async rotateRefresh(input: Record<string, unknown>, grantId: string) {
    const row = await this.inspectRefresh(input);
    // Refresh grants require offline_access. Guard the nullable Prisma field
    // before recording or querying the rotated (spent) refresh-token hash.
    const refreshHash = row.refreshTokenHash;
    if (row.id !== grantId || !refreshHash) {
      throw new McpOAuthProtocolError("invalid_grant");
    }
    const accessToken = randomToken(accessPrefix);
    const refreshToken = randomToken(refreshPrefix);
    const now = Date.now();
    let rotated: boolean;
    try {
      rotated = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.mcpOAuthGrant.updateMany({
          where: {
            id: row.id, refreshTokenHash: refreshHash,
            revokedAt: null, refreshExpiresAt: { gt: new Date() },
          },
          data: {
            accessTokenHash: hash(accessToken),
            refreshTokenHash: hash(refreshToken),
            accessExpiresAt: new Date(now + accessTtlSeconds * 1000),
          },
        });
        if (updated.count !== 1) return false;
        // Persist the *spent* hash in the same transaction as rotation:
        // an interrupted transaction must not leave the old token marked
        // consumed while a still-active grant accepts it, or vice versa.
        await tx.mcpOAuthSpentRefreshToken.create({
          data: { tokenHash: refreshHash, grantId: row.id },
        });
        return true;
      });
    } catch (error) {
      // A concurrent rotation can win the unique spent-hash insert. Revoke
      // only if durable history proves the same grant was already rotated;
      // other DB faults remain errors, never a permissive fallback.
      const spent = await this.prisma.mcpOAuthSpentRefreshToken.findUnique({
        where: { tokenHash: refreshHash },
        select: { grantId: true },
      });
      if (spent?.grantId !== row.id) throw error;
      await this.revokeRefreshLineage(row.id, row.clientId);
      throw new McpOAuthProtocolError("invalid_grant");
    }
    if (!rotated) {
      // The old token was valid at inspect but lost a concurrent compare-
      // and-swap; assume compromise, revoke the successor grant.
      await this.revokeRefreshLineage(row.id, row.clientId);
      throw new McpOAuthProtocolError("invalid_grant");
    }
    return {
      access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer",
      expires_in: accessTtlSeconds, scope: row.scope,
    };
  }

  private async revokeRefreshLineage(grantId: string, clientId: string) {
    await this.prisma.mcpOAuthGrant.updateMany({
      where: { id: grantId, clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revoke(token: unknown, clientId: unknown) {
    this.requireEnabled();
    if (typeof token !== "string" || token.length > 120) return;
    const client = await this.requireClient(clientId);
    const where = token.startsWith(refreshPrefix)
      ? { refreshTokenHash: hash(token), clientId: client.id }
      : { accessTokenHash: hash(token), clientId: client.id };
    const revoked = await this.prisma.mcpOAuthGrant.updateMany({
      where, data: { revokedAt: new Date() },
    });
    if (!revoked.count && token.startsWith(refreshPrefix)) {
      // RFC 7009 revocation is idempotent. A client may retain an earlier
      // refresh token even after rotation; its explicit disconnect must
      // still invalidate the full successor chain.
      const spent = await this.prisma.mcpOAuthSpentRefreshToken.findUnique({
        where: { tokenHash: hash(token) },
        include: { grant: { select: { clientId: true } } },
      });
      if (spent?.grant.clientId === client.id) {
        await this.revokeRefreshLineage(spent.grantId, client.id);
      }
    }
  }

  async authenticateAccessToken(raw: string, tenantId: string): Promise<AuthenticatedUser> {
    this.requireEnabled();
    if (!raw.startsWith(accessPrefix) || raw.length > 120 ||
        !tenantPattern.test(tenantId)) {
      throw new UnauthorizedException("MCP access token is not a RP resource token");
    }
    const grant = await this.prisma.mcpOAuthGrant.findUnique({
      where: { accessTokenHash: hash(raw) },
      include: {
        client: { select: { revokedAt: true } },
        user: { select: { id: true, email: true, displayName: true, status: true } },
      },
    });
    if (!grant || grant.revokedAt || grant.client.revokedAt ||
        grant.tenantId !== tenantId ||
        grant.resource !== this.resourceForTenant(tenantId) ||
        grant.accessExpiresAt.getTime() <= Date.now() ||
        grant.user.status !== UserStatus.Active) {
      throw new UnauthorizedException("MCP bearer token has an invalid resource audience");
    }
    return {
      ...grant.user,
      ...(grant.authenticatedIdpId ? { authenticatedIdpId: grant.authenticatedIdpId } : {}),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
