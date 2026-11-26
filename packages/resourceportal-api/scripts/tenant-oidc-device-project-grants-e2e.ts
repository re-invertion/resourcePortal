/**
 * Actual patched ZITADEL Device Authorization API project-grant boundary.
 *
 * The disposable GitHub fixture provisions IAM_LOGIN_CLIENT specifically to
 * exercise session.read/session.link (no production or customer credentials).
 * No browser Login V2 UI is used here. This proves backend project grants,
 * NOT the separate hosted Login V2 explicit-consent UI bug.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Api = <T>(method: string, route: string, body?: unknown) => Promise<T>;
const issuer = "https://localhost:8443";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const timeout = () => AbortSignal.timeout(20_000);

export async function proveDeviceProjectGrantEnforcement(input: {
  api: Api;
  clientId: string;
  allowed: { userId: string; loginName: string; password: string };
  denied: { userId: string; loginName: string; password: string };
}) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, "true");
  assert.equal(process.env.ZITADEL_VERSION, "v4.19.5");
  assert.equal(process.env.OIDC_ISSUER_URL, issuer);
  assert.ok(process.env.NODE_EXTRA_CA_CERTS);
  assert.notEqual(input.allowed.userId, input.denied.userId);
  const secretPath = process.env.ZITADEL_LOGIN_CLIENT_PAT_FILE ?? "";
  assert.ok(secretPath.endsWith("/var/federation/zitadel/login-client.pat"),
    "Isolated Login Client PAT path not present");
  const loginPat = readFileSync(secretPath, "utf8").trim();
  assert.ok(loginPat.length >= 32 && !/\s/.test(loginPat),
    "Invalid test-only IAM_LOGIN_CLIENT PAT");
  const authHeaders = {
    authorization: "Bearer " + loginPat,
    "content-type": "application/json",
  };

  const discoveryResponse = await fetch(issuer + "/.well-known/openid-configuration", {
    redirect: "error", signal: timeout(),
  });
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json() as {
    issuer?: string; token_endpoint?: string; jwks_uri?: string;
    device_authorization_endpoint?: string;
  };
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.token_endpoint, issuer + "/oauth/v2/token");
  assert.equal(discovery.device_authorization_endpoint,
    issuer + "/oauth/v2/device_authorization");
  assert.ok(discovery.jwks_uri && discovery.jwks_uri.startsWith(issuer + "/"));

  const createSession = async (account: typeof input.allowed) => {
    const start = await input.api<{
      sessionId?: string; sessionToken?: string;
    }>("POST", "/v2/sessions", {
      checks: { user: { loginName: account.loginName } },
    });
    assert.ok(start.sessionId && start.sessionToken, "User session was not created");
    const next = await input.api<{ sessionToken?: string }>(
      "PATCH", "/v2/sessions/" + encodeURIComponent(start.sessionId), {
        checks: { password: { password: account.password } },
      },
    );
    assert.ok(next.sessionToken, "Real password check did not verify user");
    return { sessionId: start.sessionId, sessionToken: next.sessionToken };
  };

  const newDevice = async () => {
    const request = await fetch(discovery.device_authorization_endpoint!, {
      method: "POST", redirect: "error", signal: timeout(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId, scope: "openid profile",
      }),
    });
    assert.equal(request.status, 200, "Disposable device client creation failed");
    const payload = await request.json() as {
      device_code?: string; user_code?: string;
    };
    assert.ok(payload.device_code && payload.device_code.length > 12);
    assert.ok(payload.user_code && payload.user_code.length >= 6);
    // The real ZITADEL v2 OIDC API must be readable by the special Login
    // Client identity. The same API returns 401/403 to anonymous requests.
    const lookup = await fetch(issuer + "/v2/oidc/device_authorization/" +
      encodeURIComponent(payload.user_code), {
      headers: authHeaders, redirect: "error", signal: timeout(),
    });
    assert.equal(lookup.status, 200,
      "IAM_LOGIN_CLIENT did not obtain a real Device Authorization request");
    const current = await lookup.json() as {
      deviceAuthorizationRequest?: { id?: string; clientId?: string };
    };
    assert.equal(current.deviceAuthorizationRequest?.clientId, input.clientId);
    assert.ok(current.deviceAuthorizationRequest?.id);
    return { code: payload.device_code, requestId: current.deviceAuthorizationRequest.id };
  };

  const token = async (deviceCode: string) => {
    const response = await fetch(discovery.token_endpoint!, {
      method: "POST", redirect: "error", signal: timeout(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: deviceGrant, client_id: input.clientId, device_code: deviceCode,
      }),
    });
    return { status: response.status, body: await response.json() as {
      error?: string; access_token?: string; id_token?: string; token_type?: string;
    } };
  };

  const finalize = async (id: string, user: typeof input.allowed) => {
    const session = await createSession(user);
    return fetch(issuer + "/v2/oidc/device_authorization/" + encodeURIComponent(id), {
      method: "POST", redirect: "error", signal: timeout(),
      headers: authHeaders,
      body: JSON.stringify({ session }),
    });
  };

  // Project A enforces projectRoleCheck/hasProjectCheck, but this real
  // synthetic user belongs only to tenant B. The *authorized* login client
  // must not be allowed to link an ungranted user to project A's Device app.
  const deniedDevice = await newDevice();
  const deniedApproval = await finalize(deniedDevice.requestId, input.denied);
  assert.ok(deniedApproval.status >= 400 && deniedApproval.status < 500,
    "SECURITY: ungranted tenant B user was approved for tenant A device client");
  const deniedToken = await token(deniedDevice.code);
  assert.equal(deniedToken.status, 400,
    "SECURITY: ungranted user obtained a token via Device Authorization");
  assert.ok(["authorization_pending", "access_denied"].includes(deniedToken.body.error ?? ""),
    "Ungrantable device must remain pending or explicitly denied");
  assert.ok(!deniedToken.body.access_token && !deniedToken.body.id_token,
    "SECURITY: tenant B user obtained tenant A Device JWT");

  // Positive control: same Login Client PAT/session.link, same application
  // and API routes, but the native tenant A user HAS the real project grant.
  // A 403 from missing IAM_LOGIN_CLIENT permissions must not falsely pass
  // the previous negative case.
  const allowedDevice = await newDevice();
  const allowedApproval = await finalize(allowedDevice.requestId, input.allowed);
  assert.equal(allowedApproval.status, 200,
    "Positive control failed: valid tenant A user could not approve device");
  let authorized: Awaited<ReturnType<typeof token>> | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5_200));
    const polled = await token(allowedDevice.code);
    if (polled.status === 200) { authorized = polled; break; }
    assert.equal(polled.status, 400);
    assert.ok(["authorization_pending", "slow_down"].includes(polled.body.error ?? ""),
      "Positive device check returned unexpected OAuth error");
  }
  assert.ok(authorized?.body.id_token && authorized.body.access_token,
    "Positive control never issued signed Device Authorization tokens");
  assert.equal(authorized.body.token_type?.toLowerCase(), "bearer");
  const keyset = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const id = await jwtVerify(authorized.body.id_token, keyset, {
    issuer, audience: input.clientId,
  });
  assert.equal(id.payload.sub, input.allowed.userId);
  const access = await jwtVerify(authorized.body.access_token, keyset, { issuer });
  assert.equal(access.payload.sub, input.allowed.userId);
  assert.notEqual(access.payload.sub, input.denied.userId);

  console.log("PASS: patched real ZITADEL v4.19.5 Device API rejects ungranted tenant B approval and issues signed tokens only for granted tenant A (Login Client positive control)");
}
