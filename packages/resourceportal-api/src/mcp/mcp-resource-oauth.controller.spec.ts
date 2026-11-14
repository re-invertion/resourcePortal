import fastify from "fastify";
import fastifyFormbody from "@fastify/formbody";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Body, Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import { AuthSessionService } from "../auth/auth-session.service";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";
import { McpResourceOAuthService } from "../auth/mcp-resource-oauth.service";
import { NativeLoginModeService } from "../auth/native-login-mode.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";
import {
  McpResourceOAuthController, McpResourceOAuthDiscoveryController,
} from "./mcp-resource-oauth.controller";

// Nest's real FastifyAdapter installs its own application/x-www-form-urlencoded
// parser at app.init(). Validate the production framework lifecycle without
// registering an extra Fastify formbody plugin.
@Controller("api/mcp/oauth")
class NestedOAuthFormController {
  @Post("approve")
  approve(@Body() body: { decision: string; consent_nonce: string }) {
    return body;
  }
}
@Module({ controllers: [NestedOAuthFormController] })
class NestedOAuthFormModule {}

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const origin = "https://rp.example.test";
const resource = `${origin}/api/tenants/${tenantId}/mcp`;
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const user = {
  id: userId, displayName: "Human", email: "human@example.test", status: UserStatus.Active,
};
const options = {
  clientId: "rpocli_client", redirectUri: callback, resource, tenantId,
  scope: "mcp offline_access", state: "some-client-state", challenge: "c".repeat(43),
};

function reply() {
  const r = {
    header: vi.fn(), status: vi.fn(), redirect: vi.fn(), send: vi.fn(),
    type: vi.fn(), setCookie: vi.fn(), clearCookie: vi.fn(),
  };
  r.status.mockReturnValue(r);
  r.type.mockReturnValue(r);
  return r;
}
function fixture() {
  const oauth = {
    resourceForTenant: vi.fn().mockReturnValue(resource),
    getOrigin: vi.fn().mockReturnValue(origin),
    getIssuer: vi.fn().mockReturnValue(`${origin}/api/mcp/oauth`),
    isEnabled: vi.fn().mockReturnValue(true),
    requireEnabled: vi.fn(),
    parseAuthorization: vi.fn().mockReturnValue(options),
    requireClient: vi.fn().mockResolvedValue({ id: options.clientId }),
    browserUser: vi.fn().mockResolvedValue(user),
    beginConsent: vi.fn().mockResolvedValue("rpocons_secret"),
    inspectConsent: vi.fn().mockResolvedValue({
      id: "pending-id", userId, tenantId, clientId: options.clientId,
      redirectUri: callback, codeChallenge: options.challenge, scope: options.scope,
      state: options.state,
    }),
    consumeConsent: vi.fn().mockResolvedValue({
      userId, tenantId,
    }),
    issueCode: vi.fn().mockResolvedValue("rpoc_valid-code"),
    inspectCode: vi.fn().mockResolvedValue({
      codeHash: "stored-hash", tenantId, userId, authenticatedIdpId: null,
    }),
    redeemCode: vi.fn().mockResolvedValue({ access_token: "rpoat_v1_access" }),
    inspectRefresh: vi.fn().mockResolvedValue({
      id: "grant-id", userId, tenantId, authenticatedIdpId: null,
    }),
    rotateRefresh: vi.fn().mockResolvedValue({ access_token: "rpoat_v1_rotated" }),
    revoke: vi.fn(),
    registerClient: vi.fn().mockResolvedValue({ client_id: options.clientId }),
  };
  const settings = {
    assertMcpEnabled: vi.fn().mockResolvedValue(undefined),
    assertUserCanUseMcp: vi.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ displayName: '<script>alert("xss")</script>' }) },
    tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const native = { isNativeOnly: vi.fn().mockResolvedValue(false) };
  const config = {
    get: vi.fn((key: string, fallback?: string) =>
      ({ AUTH_MODE: "oidc", NODE_ENV: "test" } as Record<string, string>)[key] ?? fallback),
  };
  const sessions = {
    getCsrfCookieName: vi.fn().mockReturnValue("rp_csrf"),
    isCookieSecure: vi.fn().mockReturnValue(true),
  };
  const upstream = {
    start: vi.fn().mockResolvedValue({
      state: "S".repeat(43),
      url: "https://zitadel.example.test/oauth/v2/authorize?client_id=12345",
    }),
    exchange: vi.fn().mockResolvedValue({
      record: {
        upstreamClientId: "12345", tenantId, clientId: options.clientId,
        redirectUri: callback, resource, scope: options.scope,
        clientState: options.state, codeChallenge: options.challenge,
      },
      idToken: "signed-jwt",
      accessToken: "zitadel-userinfo-access",
    }),
    createIdentitySession: vi.fn().mockResolvedValue("Z".repeat(43)),
  };
  const oidc = {
    authenticateMcpBootstrapTokens: vi.fn().mockResolvedValue(user),
  };
  const controller = new McpResourceOAuthController(
    oauth as unknown as McpResourceOAuthService,
    settings as unknown as TenantMcpSettingsService,
    prisma as unknown as PrismaService,
    native as unknown as NativeLoginModeService,
    config as unknown as ConfigService,
    sessions as unknown as AuthSessionService,
    upstream as never,
    oidc as never,
  );
  return { oauth, settings, prisma, controller, upstream, oidc, native };
}
function request(input: {
  cookies?: Record<string, string>; origin?: string; referer?: string; contentType?: string;
  nonceValid?: boolean; url?: string;
} = {}) {
  return {
    url: input.url ?? "/api/mcp/oauth/authorize?client_id=rpocli_client&state=some-client-state",
    headers: {
      "content-type": input.contentType ?? "application/x-www-form-urlencoded",
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.referer !== undefined ? { referer: input.referer } : {}),
    },
    cookies: input.cookies ?? { rp_csrf: "verylongvalidcsrfvalue_0123456789012345", rp_mcp_oauth_pending: "signed-cookie" },
    unsignCookie: vi.fn().mockReturnValue({
      valid: input.nonceValid ?? true, value: "rpocons_secret",
    }),
  } as unknown as FastifyRequest;
}

describe("ResourcePortal MCP OAuth 2.1 issuer and tenant consent (#442)", () => {
  it("Fastify parses real OAuth application/x-www-form-urlencoded requests, not only mocked DTOs", async () => {
    const app = fastify();
    await app.register(fastifyFormbody);
    app.post("/api/mcp/oauth/token", (req) => req.body);
    const reply = await app.inject({
      method: "POST",
      url: "/api/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: "rpoc_v1_example",
        code_verifier: "A".repeat(64),
        resource,
      }).toString(),
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      grant_type: "authorization_code", resource,
      code_verifier: "A".repeat(64),
    });
    await app.close();
  });

  it("starts Nest's FastifyAdapter once and parses OAuth HTML forms without duplicate parser registration", async () => {
    // Prevent regressions in the REAL bootstrap, not only the test adapter.
    const bootstrap = readFileSync(resolve(__dirname, "../main.ts"), "utf8");
    expect(bootstrap).not.toMatch(/app\.register\s*\(\s*fastifyFormbody/);
    const nest = await NestFactory.create<NestFastifyApplication>(
      NestedOAuthFormModule, new FastifyAdapter(), { logger: false },
    );
    try {
      await nest.init(); // previously threw FST_ERR_CTP_ALREADY_PRESENT
      const response = await nest.getHttpAdapter().getInstance().inject({
        method: "POST",
        url: "/api/mcp/oauth/approve",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "decision=approve&consent_nonce=rpocons_bound",
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        decision: "approve", consent_nonce: "rpocons_bound",
      });
    } finally {
      await nest.close();
    }
  });

  it("advertises real RP AS endpoints and does not advertise global Zitadel DCR", () => {
    const f = fixture();
    const controller = new McpResourceOAuthDiscoveryController(
      f.oauth as unknown as McpResourceOAuthService,
    );
    expect(controller.metadata()).toMatchObject({
      issuer: `${origin}/api/mcp/oauth`,
      authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
      token_endpoint: `${origin}/api/mcp/oauth/token`,
      registration_endpoint: `${origin}/api/mcp/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("MCP-only user without RP Web grant uses identity-only ZITADEL client", async () => {
    const f = fixture();
    f.oauth.browserUser.mockResolvedValueOnce(null);
    const r = reply();
    await f.controller.authorize({}, request(), r as unknown as FastifyReply);
    expect(r.status).toHaveBeenCalledWith(302);
    expect(String(r.redirect.mock.calls[0]?.[0])).toContain("https://zitadel.example.test/oauth/v2/authorize");
    expect(f.upstream.start).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, clientId: options.clientId, resource, redirectUri: callback,
    }), origin);
    expect(r.setCookie).toHaveBeenCalledWith("rp_mcp_upstream_state", "S".repeat(43),
      expect.objectContaining({ signed: true, sameSite: "lax", httpOnly: true }));

    expect(f.oauth.beginConsent).not.toHaveBeenCalled();
    expect(f.oauth.issueCode).not.toHaveBeenCalled();
  });

  it("MCP-only ZITADEL callback creates a tenant-bound identity session, never a Web grant", async () => {
    const f = fixture();
    const r = reply();
    const state = "S".repeat(43);
    const req = request({ cookies: { rp_mcp_upstream_state: "signed" } });
    req.unsignCookie = vi.fn().mockReturnValue({ valid: true, value: state });
    await f.controller.upstreamCallback({
      code: "zitadel-code", state,
    }, req, r as unknown as FastifyReply);
    expect(f.upstream.exchange).toHaveBeenCalledWith("zitadel-code", state, origin);
    expect(f.oidc.authenticateMcpBootstrapTokens).toHaveBeenCalledWith(
      "signed-jwt", "12345", state, "zitadel-userinfo-access",
    );
    expect(f.settings.assertUserCanUseMcp).toHaveBeenCalledWith(tenantId, userId);
    expect(f.upstream.createIdentitySession).toHaveBeenCalledWith(user, tenantId);
    expect(r.setCookie).toHaveBeenCalledWith(
      "rp_mcp_identity_session", "Z".repeat(43),
      expect.objectContaining({ signed: true, sameSite: "lax", httpOnly: true }),
    );
    expect(r.setCookie).toHaveBeenCalledWith(
      "rp_csrf", expect.any(String),
      expect.objectContaining({ sameSite: "lax", path: "/api/mcp/oauth" }),
    );
    const next = new URL(String(r.redirect.mock.calls[0]?.[0]), origin);
    expect(next.pathname).toBe("/api/mcp/oauth/authorize");
    expect(next.searchParams.get("resource")).toBe(resource);
    expect(next.searchParams.get("state")).toBe(options.state);
    expect(next.searchParams.get("code_challenge")).toBe(options.challenge);
  });

  it("rejects forged upstream OAuth state and revoked tenant role before consent", async () => {
    const f = fixture();
    const r = reply();
    const state = "S".repeat(43);
    const req = request({ cookies: { rp_mcp_upstream_state: "signed" } });
    req.unsignCookie = vi.fn().mockReturnValue({
      valid: true, value: "X".repeat(43),
    });
    await f.controller.upstreamCallback({
      code: "code", state,
    }, req, r as unknown as FastifyReply);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(f.upstream.exchange).not.toHaveBeenCalled();
    req.unsignCookie = vi.fn().mockReturnValue({ valid: true, value: state });
    f.settings.assertUserCanUseMcp.mockRejectedValue(new Error("MCP revoked"));
    await expect(f.controller.upstreamCallback({
      code: "code", state,
    }, req, reply() as unknown as FastifyReply)).rejects.toThrow("MCP revoked");
    expect(f.upstream.createIdentitySession).not.toHaveBeenCalled();
  });

  it("renders escaped explicit tenant consent with a signed, short-lived cookie", async () => {
    const f = fixture();
    const r = reply();
    const req = request();
    await f.controller.authorize({}, req, r as unknown as FastifyReply);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.type).toHaveBeenCalledWith("text/html; charset=utf-8");
    const html = String(r.send.mock.calls[0]?.[0]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain('name="consent_nonce" value="rpocons_secret"');
    expect(html).toContain("Połącz ChatGPT");
    expect(html).toContain("Wybrany tenant");
    expect(html).toContain("Żądany zakres dostępu");
    expect(html).toContain("offline_access");
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain('form action="/api/mcp/oauth/approve" method="post"');
    expect(r.header).toHaveBeenCalledWith("referrer-policy", "same-origin");
    expect(r.header).toHaveBeenCalledWith(
      "content-security-policy",
      expect.stringContaining("form-action 'self'"),
    );
    const cssPolicy: unknown = r.header.mock.calls.find(([key]) => key === "content-security-policy")?.[1];
    expect(cssPolicy).toMatch(/style-src 'nonce-[a-zA-Z0-9+/=]{24}'/);
    expect(cssPolicy).toContain("form-action 'self' https://chatgpt.com");
    expect(cssPolicy).not.toContain("form-action *");
    expect(html).toContain('style nonce="');
    expect(html).not.toContain("https://cdn.");
    expect(f.oauth.beginConsent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, userId, clientId: options.clientId,
    }));
    expect(r.setCookie).toHaveBeenCalledWith("rp_mcp_oauth_pending", "rpocons_secret",
      expect.objectContaining({ signed: true, httpOnly: true, secure: true, maxAge: 600 }));
    expect(f.oauth.issueCode).not.toHaveBeenCalled();
  });

  it.each(["approve", "deny"])(
    "rejects a stale A-tab %s when a second B-tab replaces its consent cookie",
    async (decision) => {
      const f = fixture();
      const replyForA = reply();
      const previousTabAForm = {
        decision,
        csrf_token: "verylongvalidcsrfvalue_0123456789012345",
        consent_nonce: "rpocons_secret",
      };
      const browserAfterVisitingTenantB = request({ origin });
      // The same browser's cookie now refers to an unrelated tenant B grant.
      // Its old A page still contains the original A nonce and CSRF.
      browserAfterVisitingTenantB.unsignCookie = vi.fn().mockReturnValue({
        valid: true, value: "rpocons_other_tenant_B",
      });
      await f.controller.approve(previousTabAForm,
        browserAfterVisitingTenantB, replyForA as unknown as FastifyReply);
      expect(replyForA.status).toHaveBeenCalledWith(400);
      expect(replyForA.send).toHaveBeenCalledWith({ error: "invalid_request" });
      expect(f.oauth.inspectConsent).not.toHaveBeenCalled();
      expect(f.oauth.consumeConsent).not.toHaveBeenCalled();
      expect(f.oauth.issueCode).not.toHaveBeenCalled();
    },
  );

  it("only issues an OAuth code after same-session signed consent and CSRF proof", async () => {
    const f = fixture();
    const r = reply();
    const req = request({ origin });
    await f.controller.approve({
      csrf_token: "verylongvalidcsrfvalue_0123456789012345",
      consent_nonce: "rpocons_secret", decision: "approve",
    }, req, r as unknown as FastifyReply);
    expect(f.oauth.inspectConsent).toHaveBeenCalledWith("rpocons_secret");
    expect(f.oauth.consumeConsent).toHaveBeenCalledWith("rpocons_secret", userId);
    expect(f.oauth.issueCode).toHaveBeenCalledTimes(1);
    const redirected = new URL(r.redirect.mock.calls[0]?.[0] as string);
    expect(redirected.origin).toBe("https://chatgpt.com");
    expect(redirected.searchParams.get("code")).toBe("rpoc_valid-code");
    expect(redirected.searchParams.get("state")).toBe("some-client-state");
    expect(redirected.searchParams.get("iss")).toBe(`${origin}/api/mcp/oauth`);
  });

  it.each(["null", undefined])(
    "accepts privacy-browser HTML POST Origin %s only with a same-origin authorization Referer",
    async (originHeader) => {
      const f = fixture();
      const r = reply();
      await f.controller.approve({
        csrf_token: "verylongvalidcsrfvalue_0123456789012345",
        consent_nonce: "rpocons_secret", decision: "approve",
      }, request({
        origin: originHeader,
        referer: `${origin}/api/mcp/oauth/authorize?client_id=rpocli_client&state=sensitive`,
      }), r as unknown as FastifyReply);
      expect(r.redirect).toHaveBeenCalledTimes(1);
      expect(f.oauth.issueCode).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { origin: "null", referer: undefined },
    { origin: "null", referer: "https://attacker.test/api/mcp/oauth/authorize" },
    { origin: undefined, referer: "https://attacker.test/api/mcp/oauth/authorize" },
    { origin: "https://attacker.test", referer: `${origin}/api/mcp/oauth/authorize` },
    { origin: "null", referer: `${origin}/api/mcp/oauth/token` },
    { origin: "null", referer: "not-a-url" },
  ])("rejects opaque/foreign form origin without trusted consent referrer %#",
    async (headers) => {
      const f = fixture();
      const r = reply();
      await expect(f.controller.approve({
        csrf_token: "verylongvalidcsrfvalue_0123456789012345",
        consent_nonce: "rpocons_secret", decision: "approve",
      }, request(headers), r as unknown as FastifyReply))
        .rejects.toThrow("MCP OAuth consent origin mismatch");
      expect(f.oauth.inspectConsent).not.toHaveBeenCalled();
      expect(f.oauth.issueCode).not.toHaveBeenCalled();
    },
  );

  it("rejects a cross-origin or cross-user OAuth consent without minting a code", async () => {
    const f = fixture();
    const r = reply();
    await expect(f.controller.approve({
      decision: "approve", csrf_token: "not-real",
    }, request({ origin }), r as unknown as FastifyReply)).rejects.toThrow("CSRF");
    await expect(f.controller.approve({
      decision: "approve", csrf_token: "verylongvalidcsrfvalue_0123456789012345",
      consent_nonce: "rpocons_secret",
    }, request({ origin: "https://attacker.test" }), r as unknown as FastifyReply))
      .rejects.toThrow("origin mismatch");
    f.oauth.browserUser.mockResolvedValueOnce({
      ...user, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    await expect(f.controller.approve({
      decision: "approve", csrf_token: "verylongvalidcsrfvalue_0123456789012345",
      consent_nonce: "rpocons_secret",
    }, request({ origin }), r as unknown as FastifyReply)).rejects.toThrow("same signed-in user");
    expect(f.oauth.issueCode).not.toHaveBeenCalled();
    expect(f.oauth.consumeConsent).not.toHaveBeenCalled();
  });

  it("redirects denied consent with access_denied and never issues a token", async () => {
    const f = fixture();
    const r = reply();
    await f.controller.approve({
      decision: "deny", csrf_token: "verylongvalidcsrfvalue_0123456789012345",
      consent_nonce: "rpocons_secret",
    }, request({ origin }), r as unknown as FastifyReply);
    const redirect = new URL(r.redirect.mock.calls[0]?.[0] as string);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("iss")).toBe(`${origin}/api/mcp/oauth`);
    expect(redirect.searchParams.get("code")).toBeNull();
    expect(f.oauth.issueCode).not.toHaveBeenCalled();
  });

  it("denies a previously federated OAuth actor after native-only cutover, for both consent and refresh", async () => {
    const f = fixture();
    const r = reply();
    f.native.isNativeOnly.mockResolvedValue(true);
    f.oauth.browserUser.mockResolvedValueOnce({
      ...user, authenticatedIdpId: "external-idp",
    });
    await expect(f.controller.authorize({}, request(),
      r as unknown as FastifyReply)).rejects.toThrow("External identity provider login is disabled");
    expect(f.oauth.beginConsent).not.toHaveBeenCalled();
    f.oauth.inspectRefresh.mockResolvedValueOnce({
      id: "old-grant", userId, tenantId, authenticatedIdpId: "external-idp",
    });
    await expect(f.controller.token({ grant_type: "refresh_token", resource },
      request(), r as unknown as FastifyReply)).rejects.toThrow(
      "External identity provider login is disabled");
    expect(f.oauth.rotateRefresh).not.toHaveBeenCalled();
  });

  it("validates tenant RBAC at both code exchange and token refresh", async () => {
    const f = fixture();
    const r = reply();
    const req = request();
    await f.controller.token({ grant_type: "authorization_code", resource }, req, r as unknown as FastifyReply);
    expect(f.settings.assertUserCanUseMcp).toHaveBeenCalledWith(tenantId, userId);
    expect(f.oauth.redeemCode).toHaveBeenCalledTimes(1);
    await f.controller.token({ grant_type: "refresh_token", resource }, req, r as unknown as FastifyReply);
    expect(f.settings.assertUserCanUseMcp).toHaveBeenCalledTimes(2);
    expect(f.oauth.rotateRefresh).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith({ access_token: "rpoat_v1_rotated" });
  });

  it("never bypasses the form content type on the token endpoint", async () => {
    const f = fixture();
    const r = reply();
    await f.controller.token({ grant_type: "authorization_code" },
      request({ contentType: "application/json" }), r as unknown as FastifyReply);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.send).toHaveBeenCalledWith({ error: "invalid_request" });
    expect(f.oauth.redeemCode).not.toHaveBeenCalled();
  });

  it("rejects revoked role at code exchange without calling issue", async () => {
    const f = fixture();
    f.settings.assertUserCanUseMcp.mockRejectedValue(new Error("SSO revoked"));
    await expect(f.controller.token({ grant_type: "authorization_code" },
      request(), reply() as unknown as FastifyReply)).rejects.toThrow("SSO revoked");
    expect(f.oauth.redeemCode).not.toHaveBeenCalled();
  });
});
