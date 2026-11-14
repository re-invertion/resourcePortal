#!/usr/bin/env node
/**
 * Real Chromium HTML-form and redirect regression for #442.
 * Executes the compiled production controller on actual HTTP requests with
 * Fastify cookies/formbody; ChatGPT's callback and bearer HTTP client are
 * represented by an isolated loopback fixture. No production credentials.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const fastify = require("fastify");
const cookiePlugin = require("@fastify/cookie");
const formbody = require("@fastify/formbody");
const { McpResourceOAuthController } = require(
  "../packages/resourceportal-api/dist/src/mcp/mcp-resource-oauth.controller.js",
);
const { TenantMcpAccessGuard } = require(
  "../packages/resourceportal-api/dist/src/mcp/tenant-mcp-access.guard.js",
);

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", authenticatedIdpId: null };
const csrf = "browser_consents_anti_csrf_token_with_32_bytes";
const nonce = "rpocons_browser_approval_transaction";
const otherTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let issuerOrigin = "";
let callbackOrigin = "";
let callbackRequest;
let lastConsentHeaders;
let allowMcp = true;
let issueCount = 0;
let readCount = 0;

const settings = {
  async assertMcpEnabled(id) { assert.equal(id, tenantId); },
  async assertUserCanUseMcp(id, idOfUser) {
    assert.equal(idOfUser, user.id);
    if (!allowMcp || id !== tenantId) throw new Error("Tenant MCP access denied");
    return { id: "member" };
  },
};
const config = {
  get(name, fallback) {
    if (name === "AUTH_MODE") return "oidc";
    if (name === "NODE_ENV") return "test";
    return fallback;
  },
};
const prisma = {
  tenant: {
    async findUnique() { return { displayName: 'Production <Tenant> & Sandbox' }; },
  },
  tenantAuthPolicy: { async findUnique() { return null; } },
};
const oauth = {
  getOrigin() { return issuerOrigin; },
  getIssuer() { return `${issuerOrigin}/api/mcp/oauth`; },
  resourceForTenant(id) { return `${issuerOrigin}/api/tenants/${id}/mcp`; },
  requireEnabled() {},
  parseAuthorization() {
    return {
      tenantId, clientId: "chatgpt-browser-client", redirectUri: `${callbackOrigin}/callback`,
      scope: "mcp offline_access", state: "chatgpt-state", challenge: "A".repeat(43),
    };
  },
  async requireClient() {},
  async browserUser() { return user; },
  async beginConsent() { return nonce; },
  async inspectConsent() {
    return {
      userId: user.id, tenantId, clientId: "chatgpt-browser-client",
      redirectUri: `${callbackOrigin}/callback`, scope: "mcp offline_access",
      state: "chatgpt-state", codeChallenge: "A".repeat(43),
    };
  },
  async consumeConsent() {},
  async issueCode() { issueCount++; return "rpoc_browser_code"; },
  async inspectCode(raw) {
    assert.equal(raw.code, "rpoc_browser_code");
    return { tenantId, userId: user.id, authenticatedIdpId: null, codeHash: "browser-code-hash" };
  },
  async redeemCode() {
    return {
      access_token: "rpoat_browser_access",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp offline_access",
    };
  },
};
const native = { async isNativeOnly() { return false; } };
const session = { getCsrfCookieName() { return "rp_csrf"; }, isCookieSecure() { return false; } };
const controller = new McpResourceOAuthController(
  oauth, settings, prisma, native, config, session,
  { start() { throw new Error("Unexpected upstream redirect"); } }, {},
);
const guard = new TenantMcpAccessGuard(settings, config, prisma, native);

const callback = fastify();
callback.get("/callback", async (request) => {
  callbackRequest = request.query;
  return { connected: true };
});

const issuer = fastify();
await issuer.register(formbody);
await issuer.register(cookiePlugin, { secret: "test-only-secure-cookie-signature-key-please" });
issuer.get("/api/mcp/oauth/authorize", async (request, reply) =>
  controller.authorize(request.query, request, reply));
issuer.post("/api/mcp/oauth/approve", async (request, reply) => {
  lastConsentHeaders = { origin: request.headers.origin, referer: request.headers.referer };
  return controller.approve(request.body, request, reply);
});
issuer.post("/api/mcp/oauth/token", async (request, reply) =>
  controller.token(request.body, request, reply));
issuer.post("/api/tenants/:tenantId/mcp", async (request, reply) => {
  if (request.headers.authorization !== "Bearer rpoat_browser_access") {
    return reply.status(401).send({ error: "invalid_token" });
  }
  request.user = user;
  try {
    await guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    });
  } catch {
    return reply.status(403).send({ error: "forbidden" });
  }
  readCount++;
  const message = request.body;
  assert.equal(message.method, "tools/call");
  assert.equal(message.params.name, "authorized_read");
  return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "permitted" }] } };
});

let browser;
try {
  const callbackAddress = await callback.listen({ host: "127.0.0.1", port: 0 });
  callbackOrigin = callbackAddress;
  const issuerAddress = await issuer.listen({ host: "127.0.0.1", port: 0 });
  issuerOrigin = issuerAddress;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{
    name: "rp_csrf", value: csrf, url: issuerOrigin,
    httpOnly: false, secure: false, sameSite: "Lax",
  }]);
  const page = await context.newPage();
  const authorize = `${issuerOrigin}/api/mcp/oauth/authorize?response_type=code&client_id=chatgpt-browser-client`;
  await page.goto(authorize);
  assert.match(await page.locator("h1").innerText(), /Połącz ChatGPT/);
  assert.match(await page.locator(".tenant").innerText(), /Production <Tenant> & Sandbox/);
  assert.equal(await page.locator('input[name="consent_nonce"]').inputValue(), nonce);
  const consentResponse = await page.request.get(authorize);
  assert.equal(consentResponse.headers()["referrer-policy"], "same-origin");
  assert.match(consentResponse.headers()["content-security-policy"], /style-src 'nonce-/);
  assert.equal(await page.locator(".scope-icon").count(), 2);
  await Promise.all([
    page.waitForURL(`${callbackOrigin}/callback?**`),
    page.getByRole("button", { name: "Zezwól na połączenie" }).click(),
  ]);
  assert.equal(callbackRequest.state, "chatgpt-state");
  assert.equal(callbackRequest.iss, `${issuerOrigin}/api/mcp/oauth`);
  assert.equal(callbackRequest.code, "rpoc_browser_code");
  assert.equal(lastConsentHeaders.origin, issuerOrigin);
  assert.ok(lastConsentHeaders.referer?.startsWith(authorize));
  assert.equal(issueCount, 1);

  // Model ChatGPT's back-channel token exchange and MCP resource call.
  const tokenResponse = await fetch(`${issuerOrigin}/api/mcp/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: callbackRequest.code,
      client_id: "chatgpt-browser-client", redirect_uri: `${callbackOrigin}/callback`,
      code_verifier: "v".repeat(64),
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  const read = (id) => fetch(`${issuerOrigin}/api/tenants/${id}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "authorized_read", arguments: {} },
    }),
  });
  const ok = await read(tenantId);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.content[0].text, "permitted");
  const crossed = await read(otherTenant);
  assert.equal(crossed.status, 403);
  allowMcp = false;
  const revoked = await read(tenantId);
  assert.equal(revoked.status, 403);
  assert.equal(readCount, 1);

  // Deny follows the same signed cookie, CSRF and origin protections, but
  // must never issue a code; the callback gets OAuth access_denied instead.
  allowMcp = true;
  await page.goto(authorize);
  await Promise.all([
    page.waitForURL(`${callbackOrigin}/callback?**`),
    page.getByRole("button", { name: "Odmów" }).click(),
  ]);
  assert.equal(callbackRequest.error, "access_denied");
  assert.equal(callbackRequest.code, undefined);
  assert.equal(issueCount, 1);
  await context.close();
  console.log("PASS: Chromium consent → signed CSRF/nonce → OAuth callback → token → tenant MCP read; foreign-origin/revoked denied");
} finally {
  if (browser) await browser.close();
  await issuer.close();
  await callback.close();
}
