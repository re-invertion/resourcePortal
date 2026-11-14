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
      // A no-referrer document policy turns Chromium/Brave HTML form POSTs
      // into Origin: null. Restrict referrers to our own issuer instead:
      // nothing about this authorization request is sent to outside sites.
      reply.header("referrer-policy", "same-origin");
      const styleNonce = randomBytes(16).toString("base64");
      // Chromium enforces form-action on redirects after the form POST.
      // The verified registered OAuth callback must therefore be an allowed
      // navigation destination, otherwise approve/deny cannot reach ChatGPT.
      // Only the validated client's callback origin is added, not a wildcard.
      const callbackOrigin = new URL(options.redirectUri).origin;
      reply.header(
        "content-security-policy",
        `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
      );
      return reply.status(200).type("text/html; charset=utf-8").send(
        renderMcpConsentPage(tenant.displayName, options.scope, csrf, nonce, styleNonce),
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
        result.accessToken,
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
      // The consent page permits same-origin referrers only. Some privacy
      // browsers send Origin: null even for a valid form POST. In that case
      // demand an explicit same-origin authorize Referer; never accept a
      // foreign Origin or an unverifiable opaque-origin request.
      if (!hasTrustedConsentOrigin(
        request.headers.origin, request.headers.referer, this.oauth.getOrigin(),
      )) {
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
      // The consent HTML and signed pending cookie MUST name the exact same
      // transaction. A second tab may overwrite this shared cookie; a valid
      // CSRF value alone does not prove that the displayed tenant/client was
      // the one approved. The nonce is a single-use secret already bound in
      // PostgreSQL to the resource, client, user, redirect and PKCE challenge.
      const shownNonce = raw.consent_nonce;
      if (typeof shownNonce !== "string" ||
          !/^[A-Za-z0-9_-]{12,128}$/.test(shownNonce) ||
          shownNonce.length !== unsigned.value.length ||
          !timingSafeEqual(Buffer.from(shownNonce), Buffer.from(unsigned.value))) {
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
    // Enforce live RP native-only policy before any new code issuance,
    // consent or refresh. Historical external grants cannot survive cutover.
    if (authenticatedIdpId && await this.nativeMode.isNativeOnly()) {
      throw new ForbiddenException("External identity provider login is disabled");
    }
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


function hasTrustedConsentOrigin(
  origin: string | undefined,
  referer: string | undefined,
  expectedOrigin: string,
): boolean {
  if (origin === expectedOrigin) return true;
  // Do not trust a Referer to override a different, explicit Origin.
  if (origin !== undefined && origin !== "null") return false;
  if (typeof referer !== "string" || referer.length > 4096) return false;
  try {
    const source = new URL(referer);
    return source.origin === expectedOrigin &&
      source.pathname === "/api/mcp/oauth/authorize" &&
      source.username === "" && source.password === "";
  } catch {
    return false;
  }
}

/** Standalone OAuth consent is delivered by the API before RP Web has loaded.
 * Use the same slate/blue visual language as ResourcePortal without linking
 * to a third-party stylesheet or needing JavaScript in a privileged form. */
function renderMcpConsentPage(
  tenant: string, scope: string, csrf: string, nonce: string, styleNonce: string,
): string {
  const scopes = scope.split(" ").filter(Boolean);
  const renderedScopes = scopes.map((item) => {
    const label = item === "mcp"
      ? "Narzędzia MCP — wyłącznie w ramach bieżących uprawnień"
      : item === "offline_access"
        ? "Odświeżanie połączenia — dopóki dostęp pozostaje przyznany"
        : item;
    return `<li><span class="scope-icon" aria-hidden="true">✓</span><div><strong>${escapeHtml(item)}</strong><span>${escapeHtml(label)}</span></div></li>`;
  }).join("");
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Połącz ChatGPT — ResourcePortal</title><style nonce="${styleNonce}">
    :root{color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc}
    *{box-sizing:border-box}body{margin:0;min-height:100vh}
    .topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:17px clamp(20px,5vw,56px);box-shadow:0 1px 2px #0f172a08}
    .brand{font-weight:750;font-size:18px;letter-spacing:-.025em}.brand-mark{display:inline-block;width:10px;height:10px;background:#2563eb;border-radius:3px;margin-right:11px}
    main{width:min(100% - 36px,620px);margin:clamp(34px,8vh,78px) auto 40px}
    .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:750;color:#2563eb;margin:0 0 13px}
    .panel{border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 32px #0f172a0c;background:#fff;padding:clamp(22px,5vw,40px)}
    h1{font-size:clamp(24px,4.8vw,31px);letter-spacing:-.04em;line-height:1.2;margin:0 0 12px}
    .intro,.notice{color:#475569;font-size:14px;line-height:1.7;margin:0 0 25px}
    .meta-label{display:block;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
    .tenant{border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;padding:16px 18px;margin-bottom:24px;overflow-wrap:anywhere}
    .tenant strong{display:block;font-size:17px;color:#1e3a8a}
    h2{font-size:15px;margin:0 0 13px}
    .scopes{list-style:none;padding:0;margin:0 0 25px}
    .scopes li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid #f1f5f9}
    .scopes li:first-child{border-top:1px solid #f1f5f9}
    .scopes strong,.scopes span{display:block;font-size:13px;line-height:1.5}
    .scopes span{color:#64748b}.scope-icon{width:24px;min-width:24px;height:24px;display:grid!important;place-items:center;color:#1d4ed8!important;background:#dbeafe;border-radius:7px;font-weight:800}
    .notice{padding:13px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;margin-bottom:24px}
    .actions{display:flex;gap:12px;flex-wrap:wrap}
    button{border-radius:8px;padding:12px 22px;font-size:14px;font-weight:700;min-height:44px;cursor:pointer}
    button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
    .allow{background:#2563eb;color:#fff;border:1px solid #2563eb}
    .allow:hover{background:#1d4ed8}.deny{background:#fff;border:1px solid #cbd5e1;color:#334155}
    .deny:hover{background:#f1f5f9}
    .footnote{font-size:12px;color:#64748b;line-height:1.5;margin:18px 0 0}
    @media(max-width:450px){.actions{flex-direction:column}.actions button{width:100%}}
  </style></head><body><header class="topbar"><span class="brand-mark" aria-hidden="true"></span><span class="brand">ResourcePortal</span></header>
  <main><div class="panel"><p class="eyebrow">Autoryzacja połączenia</p><h1>Połącz ChatGPT z ResourcePortal</h1>
  <p class="intro">Zatwierdzasz dostęp aplikacji ChatGPT do ResourcePortal na swoim koncie. Połączenie nie przyznaje nowych ról.</p>
  <section class="tenant" aria-label="Wybrany tenant"><span class="meta-label">Tenant</span><strong>${escapeHtml(tenant)}</strong></section>
  <h2>Żądany zakres dostępu</h2><ul class="scopes">${renderedScopes}</ul>
  <p class="notice">Narzędzia mogą odczytywać lub zmieniać dane, ale każde wywołanie podlega uprawnieniom użytkownika, polityce tenanta i katalogowi MCP. Dostęp można cofnąć.</p>
  <form action="/api/mcp/oauth/approve" method="post">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <input type="hidden" name="consent_nonce" value="${escapeHtml(nonce)}">
    <div class="actions"><button class="allow" type="submit" name="decision" value="approve">Zezwól na połączenie</button>
    <button class="deny" type="submit" name="decision" value="deny">Odmów</button></div>
  </form>
  <p class="footnote">Zezwolenie dotyczy wyłącznie wybranego tenanta i aktualnie przypisanych uprawnień.</p>
  </div></main></body></html>`;
}
