import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, Post, Query, Req, Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
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
      authorization_response_iss_parameter_supported: false,
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
      const user = await this.oauth.browserUser(request);
      if (!user) {
        // The existing Web login uses signed state, PKCE and a validated local
        // returnTo. Do not invent a separate upstream OAuth redirect callback.
        const returnTo = request.url;
        if (!returnTo.startsWith("/api/mcp/oauth/authorize?")) {
          throw new McpOAuthProtocolError("invalid_request");
        }
        reply.header("cache-control", "no-store");
        return reply.status(302).redirect(
          `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        );
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
      const user = await this.oauth.browserUser(request);
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
