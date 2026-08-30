import { readFileSync } from "node:fs";

const statePath = process.env.FEDERATION_E2E_STATE_FILE;
const apiUrl = (process.env.FEDERATION_E2E_API_URL ?? "http://localhost:3000/api").replace(/\/$/, "");
const issuerUrl = (process.env.OIDC_ISSUER_URL ?? "http://localhost:8080").replace(/\/$/, "");

if (!statePath) throw new Error("FEDERATION_E2E_STATE_FILE is required");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const { tenantId, projectId, serviceIdentity } = state;
if (!tenantId || !projectId || !serviceIdentity?.id || !serviceIdentity?.clientId || !serviceIdentity?.clientSecret) {
  throw new Error("Federation state does not contain service identity credentials");
}

const tokenResponse = await fetch(`${issuerUrl}/oauth/v2/token`, {
  method: "POST",
  headers: {
    authorization: `Basic ${Buffer.from(`${serviceIdentity.clientId}:${serviceIdentity.clientSecret}`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    scope: `openid profile urn:zitadel:iam:org:project:id:${projectId}:aud`,
  }),
});
const tokenText = await tokenResponse.text();
const tokenPayload = tokenText ? JSON.parse(tokenText) : {};
if (!tokenResponse.ok || !tokenPayload.access_token) {
  throw new Error(`Service identity token request failed with ${tokenResponse.status}: ${tokenText}`);
}

const listResponse = await fetch(`${apiUrl}/tenants/${encodeURIComponent(tenantId)}/service-identities`, {
  headers: { authorization: `Bearer ${tokenPayload.access_token}` },
});
const listText = await listResponse.text();
if (!listResponse.ok) {
  throw new Error(`Service identity RP authorization failed with ${listResponse.status}: ${listText}`);
}
const identities = JSON.parse(listText);
if (!Array.isArray(identities) || !identities.some((identity) => identity.id === serviceIdentity.id)) {
  throw new Error("Service identity could not read itself through tenant RBAC");
}

const platformResponse = await fetch(`${apiUrl}/platform/identity-providers`, {
  headers: { authorization: `Bearer ${tokenPayload.access_token}` },
});
if (platformResponse.status !== 403) {
  throw new Error(`Service identity unexpectedly accessed platform API (${platformResponse.status})`);
}

console.log(`ServiceIdentity client-credentials E2E passed for ${serviceIdentity.id}`);
