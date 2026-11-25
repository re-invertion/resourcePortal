/**
 * A real, *unapproved* OAuth 2.0 Device Authorization on disposable ZITADEL.
 *
 * This guards RFC 8628 fail-closed behavior and permissions on the request
 * lookup API. It does NOT prove the separate Login V2 consent/role-grant fix
 * (CVE-2026-119129) after an authenticated browser visits a device link.
 *
 * All codes and tokens are synthetic, kept in memory, and never logged.
 */
import assert from "node:assert/strict";

const issuer = "https://localhost:8443";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const deadline = () => AbortSignal.timeout(20_000);

export async function proveUnapprovedDeviceCodeCannotIssueToken(input: {
  clientId: string;
}) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, "true");
  assert.equal(process.env.OIDC_ISSUER_URL, issuer);
  assert.equal(process.env.ZITADEL_VERSION, "v4.19.5");
  assert.ok(process.env.NODE_EXTRA_CA_CERTS);
  assert.match(input.clientId, /^[a-zA-Z0-9@._~-]{1,150}$/);

  const discoveryResponse = await fetch(issuer + "/.well-known/openid-configuration", {
    redirect: "error", signal: deadline(),
  });
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json() as {
    issuer?: string; device_authorization_endpoint?: string;
    token_endpoint?: string;
  };
  assert.equal(discovery.issuer, issuer, "Device request must use pinned HTTPS issuer");
  assert.equal(discovery.device_authorization_endpoint,
    issuer + "/oauth/v2/device_authorization", "Device authorization endpoint mismatch");
  assert.equal(discovery.token_endpoint, issuer + "/oauth/v2/token");

  const request = await fetch(discovery.device_authorization_endpoint, {
    method: "POST", redirect: "error", signal: deadline(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId, scope: "openid profile",
    }),
  });
  assert.equal(request.status, 200, "Real Device Authorization client was not accepted");
  const issued = await request.json() as {
    device_code?: string; user_code?: string; verification_uri?: string;
    verification_uri_complete?: string; expires_in?: number; interval?: number;
  };
  assert.ok(issued.device_code && issued.device_code.length > 12);
  assert.ok(issued.user_code && issued.user_code.length >= 6);
  assert.ok(Number.isFinite(issued.expires_in) && Number(issued.expires_in) > 30);
  assert.ok(Number.isFinite(issued.interval) && Number(issued.interval) > 0);
  assert.equal(new URL(issued.verification_uri!).origin, issuer);
  const completeUrl = new URL(issued.verification_uri_complete!);
  assert.equal(completeUrl.origin, issuer);
  assert.equal(completeUrl.searchParams.get("user_code"), issued.user_code);

  // No code has been approved or associated with any session. Token endpoint
  // MUST fail with authorization_pending, not issue any token or generic 5xx.
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST", redirect: "error", signal: deadline(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: deviceGrant, client_id: input.clientId,
      device_code: issued.device_code,
    }),
  });
  assert.equal(tokenResponse.status, 400, "Unapproved device request yielded a token");
  const pending = await tokenResponse.json() as {
    error?: string; access_token?: string; id_token?: string; refresh_token?: string;
  };
  assert.equal(pending.error, "authorization_pending",
    "Unapproved request must remain pending, not be authorized or fail ambiguously");
  assert.ok(!pending.access_token && !pending.id_token && !pending.refresh_token,
    "Unapproved device request disclosed OAuth credentials");

  // On patched ZITADEL the v2 device request lookup needs 'session.read'.
  // Anonymous lookup of a valid user code must be refused before it can be
  // inspected or linked to a session.
  const read = await fetch(issuer + "/v2/oidc/device_authorization/" +
    encodeURIComponent(issued.user_code), {
    method: "GET", redirect: "error", signal: deadline(),
  });
  assert.ok(read.status === 401 || read.status === 403,
    "SECURITY: anonymous device request lookup did not enforce session.read");

  console.log("PASS: isolated ZITADEL v4.19.5 Device grant remains pending without consent, no token, anonymous session.read denied");

  // Re-check the *same* device authorization after a real, signed-in user
  // browser visits its verification URL but does not click Allow/Approve.
  // The callback is used by the browser-based OIDC test while the exact
  // same isolated app/code is kept alive. A permission-denied or expired
  // token response must NOT be mistaken for authorization_pending.
  const assertStillPending = async () => {
    const result = await fetch(discovery.token_endpoint!, {
      method: "POST", redirect: "error", signal: deadline(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: deviceGrant, client_id: input.clientId,
        device_code: issued.device_code!,
      }),
    });
    assert.equal(result.status, 400,
      "SECURITY: signed-in browser visit authorized a device without explicit consent");
    const value = await result.json() as {
      error?: string; access_token?: string; id_token?: string; refresh_token?: string;
    };
    assert.ok(value.error === "authorization_pending" || value.error === "slow_down",
      "Device token is no longer pending after a browser visited verification URL");
    assert.ok(!value.access_token && !value.id_token && !value.refresh_token,
      "SECURITY: implicit device approval leaked OAuth tokens");
  };
  return { verificationUri: issued.verification_uri_complete!, assertStillPending };
}
