import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, Post, Query, Req, Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpUpstreamLoginService } from "../auth/mcp-upstream-login.service";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { AuthSessionService } from "../auth/auth-session.service";
import { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { McpOAuthProtocolError, McpResourceOAuthService } from "../auth/mcp-resource-oauth.service";
import { NativeLoginModeService } from "../auth/native-login-mode.service";
import { assertTenantProviderPolicy } from "../auth/tenant-provider-policy";
import { PrismaService } from "../prisma/prisma.service";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

/** OAuth AS under RP, rather than forwarding MCP bearer credentials to ZITADEL.
 * Discovery URL follows RFC 8414's path-based issuer convention.
 */
@Public()
@Controller(".well-known/oauth-authorization-server/api/mcp/oauth")
export class McpResourceOAuthDiscoveryController {
  constructor(private readonly oauth: McpResourceOAuthService) {}

  @Get()
  @Header("cache-control", "public, max-age=300")
  @Header("access-control-allow-origin", "*")
  metadata() {
    const issuer = this.oauth.getIssuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp", "offline_access"],
      authorization_response_iss_parameter_supported: true,
    };
  }
}

@Public()
@Controller("mcp/oauth")
export class McpResourceOAuthController {
  constructor(
    private readonly oauth: McpResourceOAuthService,
    private readonly settings: TenantMcpSettingsService,
    private readonly prisma: PrismaService,
    private readonly nativeMode: NativeLoginModeService,
    private readonly config: ConfigService,
    private readonly sessions: AuthSessionService,
    private readonly upstream: McpUpstreamLoginService,
    private readonly oidc: OidcAuthService,
  ) {}

  @Post("register")
  async register(@Body() metadata: unknown, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const registration = await this.oauth.registerClient(metadata);
      reply.header("cache-control", "no-store");
      return reply.status(201).send(registration);
    });
  }

  @Get("authorize")
  async authorize(
    @Query() params: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.respond(reply, async () => {
      this.oauth.requireEnabled();
      if (request.url.length > 1800) throw new McpOAuthProtocolError("invalid_request");
      const options = this.oauth.parseAuthorization(params);
      await this.oauth.requireClient(options.clientId, options.redirectUri);
      await this.settings.assertMcpEnabled(options.tenantId);
      const user = await this.oauth.browserUser(request, options.tenantId);
      if (!user) {
        // Do not require a native Web grant merely to connect tenant MCP.
        // ZITADEL signs an identity-only ID token for a tenant-specific
        // allow-listed client; ResourcePortal will mint the resource token.
        const upstream = await this.upstream.start({
          tenantId: options.tenantId, clientId: options.clientId,
          resource: this.oauth.resourceForTenant(options.tenantId),
          redirectUri: options.redirectUri, clientState: options.state,
          challenge: options.challenge, scope: options.scope,
        }, this.oauth.getOrigin());
        reply.setCookie("rp_mcp_upstream_state", upstream.state, {
          signed: true, httpOnly: true, secure: this.sessions.isCookieSecure(),
          sameSite: "lax", path: "/api/mcp/oauth/upstream/callback", maxAge: 600,
        });
        reply.header("cache-control", "no-store");
        return reply.status(302).redirect(upstream.url);
      }
      await this.assertUser(options.tenantId, user.id, user.authenticatedIdpId);
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: options.tenantId }, select: { displayName: true },
      });
      if (!tenant) throw new McpOAuthProtocolError("invalid_target");
      const csrf = request.cookies[this.sessions.getCsrfCookieName()];
      if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(csrf)) {
        throw new ForbiddenException("RP login CSRF proof is required for MCP consent");
      }
      const nonce = await this.oauth.beginConsent({
        tenantId: options.tenantId, clientId: options.clientId,
        redirectUri: options.redirectUri, challenge: options.challenge,
        scope: options.scope, state: options.state, userId: user.id,
      });
      reply.setCookie("rp_mcp_oauth_pending", nonce, {
        signed: true, httpOnly: true, secure: this.sessions.isCookieSecure(),
        sameSite: "lax", path: "/api/mcp/oauth", maxAge: 600,
      });
      reply.header("referrer-policy", "no-referrer");
      return reply.status(200).type("text/html; charset=utf-8").send(
        `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoryzacja ChatGPT MCP</title></head><body><main style="max-width:38rem;margin:4rem auto;font-family:system-ui,sans-serif;padding:1rem"><h1>Połącz ChatGPT z ResourcePortal</h1><p>ChatGPT będzie mógł używać narzędzi w tenantcie <strong>${escapeHtml(tenant.displayName)}</strong>, zgodnie z Twoimi uprawnieniami ResourcePortal. Narzędzia mogą odczytywać i modyfikować dane; dostęp możesz później cofnąć.</p><form action="/api/mcp/oauth/approve" method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit" name="decision" value="approve">Zezwól na połączenie</button> <button type="submit" name="decision" value="deny">Odmów</button></form></main></body></html>`,
      );
    });
  }

  @Get("upstream/callback")
  async upstreamCallback(
    @Query() params: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.respond(reply, async () => {
      this.oauth.requireEnabled();
      const saved = request.cookies.rp_mcp_upstream_state;
      if (!saved || typeof request.unsignCookie !== "function") {
        throw new McpOAuthProtocolError("invalid_request");
      }
      const unsigned = request.unsignCookie(saved);
      if (!unsigned.valid || unsigned.value !== params.state) {
        throw new McpOAuthProtocolError("invalid_request");
      }
      // Cookie must not be reused even if an earlier callback was unsuccessful.
      reply.clearCookie("rp_mcp_upstream_state", {
        path: "/api/mcp/oauth/upstream/callback",
      });
      if (typeof params.error === "string") {
        throw new McpOAuthProtocolError("access_denied");
      }
      const result = await this.upstream.exchange(
        params.code, params.state, this.oauth.getOrigin(),
      );
      const user = await this.oidc.authenticateMcpBootstrapTokens(
        result.idToken, result.record.upstreamClientId, unsigned.value,
      );
      await this.assertUser(result.record.tenantId, user.id, user.authenticatedIdpId);
      const identityCookie = await this.upstream.createIdentitySession(
        user, result.record.tenantId,
      );
      reply.setCookie("rp_mcp_identity_session", identityCookie, {
        signed: true, httpOnly: true, secure: this.sessions.isCookieSecure(),
        sameSite: "lax", path: "/api/mcp/oauth", maxAge: 600,
      });
      // The MCP-only browser has no RP Web login and therefore no RP Web
      // CSRF cookie. Issue just the CSRF double-submit cookie: it grants no
      // RP Web/API access, and consent still requires a signed identity proof.
      reply.setCookie(this.sessions.getCsrfCookieName(),
        randomBytes(32).toString("base64url"), {
          httpOnly: false, secure: this.sessions.isCookieSecure(),
          sameSite: "lax", path: "/api/mcp/oauth", maxAge: 600,
        });
      const target = new URL("/api/mcp/oauth/authorize", this.oauth.getOrigin());
      target.searchParams.set("response_type", "code");
      target.searchParams.set("client_id", result.record.clientId);
      target.searchParams.set("redirect_uri", result.record.redirectUri);
      target.searchParams.set("resource", result.record.resource);
      target.searchParams.set("scope", result.record.scope);
      target.searchParams.set("state", result.record.clientState);
      target.searchParams.set("code_challenge", result.record.codeChallenge);
      target.searchParams.set("code_challenge_method", "S256");
      reply.header("referrer-policy", "no-referrer");
      return reply.status(302).redirect(target.pathname + target.search);
    });
  }

  /** Consent is a POST with RP's existing double-submit CSRF token, a
   * signed short-lived cookie and an atomically consumed database record.
   * main.ts exempts ONLY this endpoint from its header-only CSRF mechanism,
   * since a native HTML form cannot supply x-csrf-token.
   */
  @Post("approve")
  @HttpCode(200)
  async approve(@Body() raw: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      this.requireForm(request);
      if (!isRecord(raw) || !["approve", "deny"].includes(String(raw.decision))) {
        throw new McpOAuthProtocolError("invalid_request");
      }
      const csrf = request.cookies[this.sessions.getCsrfCookieName()];
      const posted = raw.csrf_token;
      if (typeof csrf !== "string" || typeof posted !== "string" ||
          csrf.length < 32 || csrf.length !== posted.length ||
          !timingSafeEqual(Buffer.from(csrf), Buffer.from(posted))) {
        throw new ForbiddenException("MCP OAuth consent CSRF proof is invalid");
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== this.oauth.getOrigin()) {
        throw new ForbiddenException("MCP OAuth consent origin mismatch");
      }
      const cookie = request.cookies.rp_mcp_oauth_pending;
      if (!cookie || typeof request.unsignCookie !== "function") {
        throw new McpOAuthProtocolError("invalid_request");
      }
      const unsigned = request.unsignCookie(cookie);
      if (!unsigned.valid || !unsigned.value) {
        throw new McpOAuthProtocolError("invalid_request");
      }
      const pending = await this.oauth.inspectConsent(unsigned.value);
      const user = await this.oauth.browserUser(request, pending.tenantId);
      if (!user || pending.userId !== user.id) {
        throw new ForbiddenException("MCP OAuth consent requires the same signed-in user");
      }
      await this.oauth.requireClient(pending.clientId, pending.redirectUri);
      await this.assertUser(pending.tenantId, user.id, user.authenticatedIdpId);
      await this.oauth.consumeConsent(unsigned.value, user.id);
      reply.clearCookie("rp_mcp_oauth_pending", { path: "/api/mcp/oauth" });
      const location = new URL(pending.redirectUri);
      if (raw.decision === "deny") {
        location.searchParams.set("error", "access_denied");
      } else {
        const code = await this.oauth.issueCode({
          user, tenantId: pending.tenantId, clientId: pending.clientId,
          redirectUri: pending.redirectUri, challenge: pending.codeChallenge,
          scope: pending.scope,
        });
        location.searchParams.set("code", code);
      }
      location.searchParams.set("state", pending.state);
      // RFC 9207 issuer identification protects the ChatGPT callback from
      // OAuth mix-up and enables its stable connector callback URI. The exact
      // value MUST match our AS metadata and protected-resource advertisement.
      location.searchParams.set("iss", this.oauth.getIssuer());
      reply.header("referrer-policy", "no-referrer");
      return reply.status(302).redirect(location.toString());
    });
  }

  @Post("token")
  @HttpCode(200)
  async token(@Body() raw: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      this.requireForm(request);
      if (!isRecord(raw)) throw new McpOAuthProtocolError("invalid_request");
      let tokens;
      if (raw.grant_type === "authorization_code") {
        const code = await this.oauth.inspectCode(raw);
        await this.assertUser(code.tenantId, code.userId, code.authenticatedIdpId);
        tokens = await this.oauth.redeemCode(raw, code.codeHash);
      } else if (raw.grant_type === "refresh_token") {
        const grant = await this.oauth.inspectRefresh(raw);
        await this.assertUser(grant.tenantId, grant.userId, grant.authenticatedIdpId);
        tokens = await this.oauth.rotateRefresh(raw, grant.id);
      } else {
        throw new McpOAuthProtocolError("unsupported_grant_type");
      }
      return reply.status(200).send(tokens);
    });
  }

  @Post("revoke")
  @HttpCode(200)
  async revoke(@Body() raw: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      this.requireForm(request);
      if (!isRecord(raw)) throw new McpOAuthProtocolError("invalid_request");
      await this.oauth.revoke(raw.token, raw.client_id);
      return reply.status(200).send({});
    });
  }

  private async assertUser(tenantId: string, userId: string, authenticatedIdpId?: string | null) {
    await this.settings.assertUserCanUseMcp(tenantId, userId);
    await assertTenantProviderPolicy(
      this.prisma, tenantId, authenticatedIdpId ?? undefined,
      () => this.nativeMode.isNativeOnly(),
    );
  }

  private requireForm(request: FastifyRequest) {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" ||
        !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new McpOAuthProtocolError("invalid_request");
    }
  }

  private async respond(reply: FastifyReply, action: () => Promise<unknown>) {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    try {
      if (this.config.get<string>("AUTH_MODE", "dev") === "dev" &&
          this.config.get<string>("NODE_ENV") === "production") {
        throw new ServiceUnavailableException("Production OAuth requires OIDC login");
      }
      return await action();
    } catch (error) {
      if (error instanceof McpOAuthProtocolError) {
        return reply.status(error.status).send({ error: error.code });
      }
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
