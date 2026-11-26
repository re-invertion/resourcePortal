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
        `default-src 'none'; img-src 'self'; style-src 'nonce-${styleNonce}'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
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
  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Połącz ChatGPT — ResourcePortal</title>
  <style nonce="${styleNonce}">
    :root{color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#F7F9FC}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh}
    .workspace{display:grid;grid-template-columns:minmax(430px,42vw) minmax(0,1fr);min-height:100vh;min-height:100dvh}
    .aside{position:relative;isolation:isolate;display:flex;flex-direction:column;overflow:hidden;min-width:0;padding:48px;background:#122033;color:#fff}
    .aside::before,.aside::after{content:"";position:absolute;z-index:-1;border-radius:50%;pointer-events:none}
    .aside::before{width:360px;height:360px;top:64px;left:40px;background:#17365E;opacity:.75}
    .aside::after{width:310px;height:310px;right:-64px;bottom:-56px;background:#18375F;opacity:.65}
    .brand-inverse{display:block;width:250px;max-width:100%;height:auto}
    .aside-content{display:flex;flex:1;flex-direction:column;justify-content:center;padding:48px 0;max-width:390px}
    .aside h2{font-size:clamp(28px,2.8vw,34px);font-weight:650;line-height:1.25;letter-spacing:-.025em;margin:0 0 24px;color:#fff}
    .aside-intro{color:#D9E8FF;font-size:14px;line-height:1.65;margin:0}
    .assurances{display:grid;gap:22px;margin-top:44px}
    .assurance{display:flex;align-items:flex-start;gap:14px}
    .assurance-icon{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;border:1px solid #ffffff25;border-radius:50%;background:#ffffff18;color:#fff;font-size:14px;font-weight:700}
    .assurance strong{display:block;color:#fff;font-size:14px;line-height:1.4}
    .assurance span:last-child{display:block;margin-top:4px;color:#C6D5EA;font-size:13px;line-height:1.5}
    .content{display:flex;flex-direction:column;min-width:0;min-height:100vh;min-height:100dvh;padding:32px clamp(16px,4vw,56px)}
    .content-header{display:flex;min-height:44px;align-items:center;justify-content:space-between;gap:18px}
    .brand-mobile{display:none;width:140px;max-width:45vw;height:auto}
    .header-label{margin-left:auto;font-size:13px;font-weight:600;color:#526070}
    main{display:flex;flex:1;align-items:center;width:100%;max-width:520px;margin:0 auto;padding:36px 0 48px}
    .main-inner{width:100%;min-width:0}
    .intro-heading{margin:0 0 12px}
    .intro-heading strong{display:block;font-size:18px;font-weight:650;line-height:1.55;color:#172033}
    .intro-heading span{display:block;margin-top:3px;font-size:13px;line-height:1.6;color:#5B6678}
    .panel{padding:clamp(24px,4vw,40px);background:#fff;border:1px solid #D7E0EC;border-radius:10px;box-shadow:0 18px 48px #17203324}
    .eyebrow{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#1769E0;margin:0 0 12px}
    h1{font-size:clamp(25px,3vw,28px);font-weight:650;line-height:1.22;letter-spacing:-.025em;color:#172033;margin:0 0 16px}
    .intro{font-size:14px;line-height:1.65;color:#5B6678;margin:0 0 24px}
    .tenant{padding:16px 18px;background:#F4F7FB;border:1px solid #D7E0EC;border-radius:8px;margin-bottom:26px;overflow-wrap:anywhere}
    .meta-label{display:block;margin-bottom:6px;color:#526070;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    .tenant strong{display:block;font-size:16px;font-weight:650;color:#172033}
    h2{font-size:15px;font-weight:650;color:#172033;margin:0 0 8px}
    .scopes{list-style:none;padding:0;margin:0 0 22px}
    .scopes li{display:flex;align-items:flex-start;gap:12px;padding:13px 0;border-bottom:1px solid #E8EDF3}
    .scopes li:first-child{border-top:1px solid #E8EDF3}
    .scope-icon{display:grid;place-items:center;flex:0 0 28px;width:28px;height:28px;background:#EAF3FF;border-radius:8px;color:#1769E0;font-size:14px;font-weight:700}
    .scopes li strong{display:block;color:#172033;font-size:13px;line-height:1.5}
    .scopes li div span{display:block;color:#5B6678;font-size:13px;line-height:1.5}
    .notice{margin:0 0 24px;padding:14px 16px;background:#F4F7FB;border:1px solid #D7E0EC;border-radius:8px;color:#526070;font-size:13px;line-height:1.65}
    form{margin:0}
    .actions{display:flex;flex-wrap:wrap;gap:12px}
    button{display:inline-flex;justify-content:center;align-items:center;min-height:44px;border-radius:6px;padding:10px 20px;font-family:inherit;font-size:14px;font-weight:600;line-height:1.4;cursor:pointer;transition:background-color .15s,border-color .15s}
    button:focus-visible{outline:2px solid #1769E0;outline-offset:3px}
    .allow{background:#1769E0;border:1px solid #1769E0;color:#fff}
    .allow:hover{background:#0f5fcf;border-color:#0f5fcf}
    .deny{background:#fff;border:1px solid #B9C5D6;color:#172033}
    .deny:hover{background:#F4F7FB}
    .footnote{color:#5B6678;font-size:12px;line-height:1.6;margin:18px 0 0}
    @media(max-width:979px){.workspace{grid-template-columns:minmax(0,1fr)}.aside{display:none}.brand-mobile{display:block}.content{padding:20px 24px}.content-header{min-height:40px}}
    @media(max-width:520px){.content{padding:20px 16px}.header-label{font-size:11px}.panel{padding:24px}.actions{flex-direction:column}.actions button{width:100%}main{padding:28px 0 36px}}
    @media(prefers-reduced-motion:reduce){button{transition:none}}
  </style>
</head>
<body>
<div class="workspace">
  <aside class="aside" aria-label="O ResourcePortal">
    <img class="brand-inverse" src="/brand/resourceportal-wordmark-white-hq.png" alt="ResourcePortal">
    <div class="aside-content">
      <h2>Bezpieczny dostęp do Twojej infrastruktury.</h2>
      <p class="aside-intro">Połącz narzędzia ChatGPT z ResourcePortal, zachowując kontrolę nad dostępem i uprawnieniami.</p>
      <div class="assurances">
        <div class="assurance"><span class="assurance-icon" aria-hidden="true">✓</span><div><strong>Twoje uprawnienia</strong><span>Połączenie nie dodaje nowych ról ani dostępu do innych tenantów.</span></div></div>
        <div class="assurance"><span class="assurance-icon" aria-hidden="true">✓</span><div><strong>Kontrola nad połączeniem</strong><span>Możesz cofnąć autoryzację i zakończyć dostęp w dowolnym momencie.</span></div></div>
      </div>
    </div>
  </aside>
  <div class="content">
    <header class="content-header">
      <img class="brand-mobile" src="/brand/resourceportal-wordmark-hq.png" alt="ResourcePortal">
      <span class="header-label">Bezpieczna autoryzacja OAuth</span>
    </header>
    <main>
      <div class="main-inner">
        <p class="intro-heading"><strong>Autoryzacja aplikacji</strong><span>Potwierdź dostęp do wybranego tenanta.</span></p>
        <div class="panel">
          <p class="eyebrow">Zgoda na połączenie</p>
          <h1>Połącz ChatGPT z ResourcePortal</h1>
          <p class="intro">ChatGPT prosi o dostęp do narzędzi ResourcePortal. Połączenie nie przyznaje nowych ról.</p>
          <section class="tenant" aria-label="Wybrany tenant">
            <span class="meta-label">Wybrany tenant</span>
            <strong>${escapeHtml(tenant)}</strong>
          </section>
          <h2>Żądany zakres dostępu</h2>
          <ul class="scopes">${renderedScopes}</ul>
          <p class="notice">Narzędzia mogą odczytywać lub zmieniać dane, ale każde wywołanie nadal podlega Twoim uprawnieniom, polityce tenanta i katalogowi MCP. Dostęp możesz cofnąć.</p>
          <form action="/api/mcp/oauth/approve" method="post">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
            <input type="hidden" name="consent_nonce" value="${escapeHtml(nonce)}">
            <div class="actions">
              <button class="allow" type="submit" name="decision" value="approve">Zezwól na połączenie</button>
              <button class="deny" type="submit" name="decision" value="deny">Odmów</button>
            </div>
          </form>
          <p class="footnote">Zezwolenie dotyczy tylko wybranego tenanta i aktualnie przypisanych uprawnień.</p>
        </div>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;
}
