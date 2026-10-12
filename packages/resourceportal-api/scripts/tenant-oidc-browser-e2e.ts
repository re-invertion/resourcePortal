import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Auth Code + PKCE with real signed tokens from the isolated HTTPS ZITADEL.
 * Credentials are synthetic and short lived. Never store/print raw JWTs.
 */
export async function runOidcAuthorizationE2E(input: {
  issuer: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
  userId: string;
  userName: string;
  password: string;
}) {
  assert.equal(input.issuer, "https://localhost:8443");
  const discovery = await (await fetch(input.issuer + "/.well-known/openid-configuration")).json() as {
    authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string;
  };
  assert.equal(discovery.issuer, input.issuer);
  const challengeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(challengeVerifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const callback = "http://127.0.0.1:8765/oidc/callback";
  let resolveCallback!: (url: URL) => void;
  const result = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((req, response) => {
    const parsed = new URL(req.url ?? "/", callback);
    if (parsed.pathname === "/oidc/callback") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Isolated RP tenant login E2E complete");
      resolveCallback(parsed);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8765, "127.0.0.1", resolve);
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const scope = [
      "openid", "profile", "email", "offline_access",
      "urn:zitadel:iam:org:project:id:" + input.projectId + ":aud",
      "urn:zitadel:iam:org:projects:roles",
    ].join(" ");
    const authorize = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: input.clientId, redirect_uri: callback,
      response_type: "code", scope, state, nonce,
      code_challenge: codeChallenge, code_challenge_method: "S256",
    })) authorize.searchParams.set(key, value);
    await page.goto(authorize.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    let enteredName = false;
    let enteredPassword = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (page.url().startsWith(callback)) break;
      const mfaSkip = page.locator('form[action="/ui/login/mfa/prompt"] button[name="skip"][value="true"]');
      if (await mfaSkip.isVisible().catch(() => false)) {
        await mfaSkip.click();
        continue;
      }
      const password = page.locator('input[type="password"]').first();
      if (!enteredPassword && await password.isVisible().catch(() => false)) {
        await password.fill(input.password);
        enteredPassword = true;
        await page.locator('button[type="submit"], input[type="submit"]').first().click();
        continue;
      }
      const nameField = page.locator(
        '#loginName, #loginname, input[name="loginName"], input[name="username"], input[autocomplete="username"]',
      ).first();
      if (!enteredName && await nameField.isVisible().catch(() => false)) {
        await nameField.fill(input.userName);
        enteredName = true;
        await page.locator('button[type="submit"], input[type="submit"]').first().click();
        continue;
      }
      const consent = page.locator(
        'button[name="accept"], button[name="allow"], button:has-text("Allow"), button:has-text("Continue")',
      ).first();
      if (enteredPassword && await consent.isVisible().catch(() => false)) {
        await consent.click();
        continue;
      }
      await page.waitForTimeout(350);
    }
    if (!page.url().startsWith(callback)) {
      throw new Error("Live ZITADEL OIDC login did not reach callback (last path: " +
        new URL(page.url()).pathname + ")");
    }
    const responseUrl = await Promise.race([
      result, new Promise<URL>((_, reject) => setTimeout(() => reject(new Error("Callback timeout")), 10000)),
    ]);
    assert.equal(responseUrl.searchParams.get("state"), state);
    const code = responseUrl.searchParams.get("code");
    assert.ok(code && !responseUrl.searchParams.get("error"), "ZITADEL refused authorization code");
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: challengeVerifier,
    });
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(input.clientId + ":" + input.clientSecret).toString("base64"),
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!tokenResponse.ok) throw new Error("ZITADEL code exchange denied HTTP " + tokenResponse.status);
    const tokens = await tokenResponse.json() as { id_token?: string; access_token?: string; refresh_token?: string };
    assert.ok(tokens.id_token && tokens.access_token && tokens.refresh_token,
      "OIDC exchange returned incomplete tokens (including offline refresh)");
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const id = await jwtVerify(tokens.id_token, jwks, { issuer: input.issuer, audience: input.clientId });
    assert.equal(id.payload.sub, input.userId, "Unexpected native ZITADEL identity");
    assert.equal(id.payload.nonce, nonce);
    const access = await jwtVerify(tokens.access_token, jwks, { issuer: input.issuer });
    const audiences = Array.isArray(access.payload.aud) ? access.payload.aud : [access.payload.aud];
    assert.ok(audiences.includes(input.projectId), "Tenant project missing from JWT audience");
    const ownRoles = access.payload["urn:zitadel:iam:org:project:" + input.projectId + ":roles"] ??
      access.payload["urn:zitadel:iam:org:project:roles"];
    assert.ok(ownRoles && JSON.stringify(ownRoles).includes("rp.tenant.member"),
      "Real token omitted the tenant's membership role");
    // Exercise an actual refresh while the grant is still active, not merely
    // the presence of an unused refresh token in the initial response.
    const refreshResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(input.clientId + ":" + input.clientSecret).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!refreshResponse.ok) throw new Error("Live OIDC refresh denied HTTP " + refreshResponse.status);
    const refreshed = await refreshResponse.json() as { access_token?: string; refresh_token?: string };
    assert.ok(refreshed.access_token, "Refresh succeeded but no new access token was returned");
    const rotated = await jwtVerify(refreshed.access_token, jwks, { issuer: input.issuer });
    const rotatedRole = rotated.payload["urn:zitadel:iam:org:project:" + input.projectId + ":roles"] ??
      rotated.payload["urn:zitadel:iam:org:project:roles"];
    assert.ok(rotatedRole && JSON.stringify(rotatedRole).includes("rp.tenant.member"),
      "A valid grant was lost during refresh before revocation");
    // RP-initiated sign-out must terminate the user-agent session and return
    // to a strictly preregistered post-logout URI. No raw ID token in the URL.
    const logout = new URL(input.issuer + "/oidc/v1/end_session");
    logout.searchParams.set("client_id", input.clientId);
    logout.searchParams.set("post_logout_redirect_uri", input.issuer + "/logout");
    logout.searchParams.set("state", randomBytes(12).toString("base64url"));
    await page.goto(logout.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    let didLogout = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (new URL(page.url()).pathname === "/logout") {
        didLogout = true;
        break;
      }
      const confirm = page.locator(
        'button[name="logout"], button[type="submit"]:has-text("Logout"), button:has-text("Sign out")',
      ).first();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click();
        continue;
      }
      await page.waitForTimeout(250);
    }
    assert.ok(didLogout, "ZITADEL did not complete RP-initiated logout to registered URI");
    console.log("PASS: real HTTPS Authorization Code + PKCE, state/nonce, signed ID/access JWT,");
    console.log("  native user, tenant roles, live refresh and RP-initiated logout (tokens not logged).");
    return { refreshToken: refreshed.refresh_token ?? tokens.refresh_token!,
      clientId: input.clientId, clientSecret: input.clientSecret,
      issuer: input.issuer, projectId: input.projectId };
  } catch (error) {
    // Never include page content, cookies, tokens or credentials in diagnostics.
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/**
 * A revoked tenant project grant must never be reasserted by a refresh token.
 * The authorization server may reject the refresh completely, or return a
 * new token without the role. Existing old JWTs live until their expiry.
 */
export async function assertRevokedRefreshCannotAuthorizeTenant(session: {
  refreshToken: string; clientId: string; clientSecret: string;
  issuer: string; projectId: string;
}) {
  const discovery = await (await fetch(session.issuer + "/.well-known/openid-configuration")).json() as {
    token_endpoint: string; jwks_uri: string;
  };
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(session.clientId + ":" + session.clientSecret).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: session.refreshToken,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    console.log("PASS: ZITADEL denied refresh after user project grant revocation");
    return;
  }
  const responseBody = await response.json() as { access_token?: string };
  assert.ok(responseBody.access_token, "Refresh did not return an access token");
  const { payload } = await jwtVerify(responseBody.access_token,
    createRemoteJWKSet(new URL(discovery.jwks_uri)), { issuer: session.issuer });
  const roles = payload["urn:zitadel:iam:org:project:" + session.projectId + ":roles"] ??
    payload["urn:zitadel:iam:org:project:roles"];
  assert.ok(!JSON.stringify(roles ?? {}).includes("rp.tenant.member"),
    "SECURITY: revoked project role was still present in newly refreshed JWT");
  console.log("PASS: refreshed signed JWT omits revoked tenant role");
}
