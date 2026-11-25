#!/usr/bin/env node
"use strict";
// True frontend+API preflight only. Login V2 user consent needs distinct E2E.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const issuer = "https://localhost:8443";
for (const [key,value] of Object.entries({
  GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
  RP_LOGIN_V2_E2E_ISOLATED: "true", ZITADEL_VERSION: "v4.19.5",
})) assert.equal(process.env[key], value);
assert.ok(process.env.NODE_EXTRA_CA_CERTS);
(async () => {
  const admin = fs.readFileSync(
    path.join(__dirname, "../../var/federation/zitadel/admin.pat"), "utf8"
  ).trim();
  assert.ok(admin.length >= 32 && !/\s/.test(admin));
  const headers = { authorization: "Bearer " + admin,
    "content-type": "application/json" };
  const init = await fetch(issuer + "/v2/features/instance", {
    method: "PUT", redirect: "error",
    headers, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ loginV2: { required: true,
      baseUri: issuer + "/ui/v2/login/" } }),
  });
  assert.ok([200,204].includes(init.status),
    "Login V2 feature activation failed: HTTP " + init.status);
  const features = await fetch(issuer + "/v2/features/instance", {
    headers, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  assert.equal(features.status, 200);
  const actual = await features.json();
  assert.equal((actual.features?.loginV2 ?? actual.loginV2)?.required, true,
    "Real ZITADEL is still running Login V1");
  const oidc = await fetch(issuer + "/.well-known/openid-configuration", {
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  assert.equal(oidc.status, 200);
  const discovery = await oidc.json();
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.device_authorization_endpoint,
    issuer + "/oauth/v2/device_authorization");
  const login = await fetch(issuer + "/ui/v2/login/healthy", {
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  assert.equal(login.status, 200, "Pinned real Login V2 frontend is not routed");
  console.log("PASS: disposable patched ZITADEL API Login V2 REQUIRED, real separate Login V2 UI healthy via same-origin HTTPS router");
  // No claim of signed-in device consent or project-role enforcement.
})().catch(error => {
  console.error("BLOCKED: isolated Login V2 preflight: " +
    String(error.message).slice(0, 240));
  process.exitCode=1;
});
