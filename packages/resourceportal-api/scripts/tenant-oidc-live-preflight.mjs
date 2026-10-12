#!/usr/bin/env node
/**
 * Strict, read-only prerequisite for the tenant IdP live E2E certification.
 * This DOES NOT prove that authorization code, consent, refresh, logout, or
 * cross-tenant denial work: manual browser E2E and signed-token verification
 * are mandatory before enabling TENANT_OIDC_ACTIVATION_ALLOWED.
 */
const mandatory = [
  "OIDC_ISSUER_URL",
  "ZITADEL_MANAGEMENT_TOKEN",
  "ZITADEL_ORGANIZATION_ID",
  "ZITADEL_TEST_PROJECT_ID",
];
const missing = mandatory.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error("BLOCKED: tenant OIDC live preflight requires " + missing.join(", "));
  process.exitCode = 2;
} else {
  try {
    const issuer = process.env.OIDC_ISSUER_URL.replace(/\/$/, "");
    const base = (process.env.ZITADEL_MANAGEMENT_URL || issuer).replace(/\/$/, "");
    for (const [description, raw] of [["Issuer", issuer], ["ZITADEL management", base]]) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error(description + " must be an HTTPS endpoint without embedded credentials");
      }
    }
    const get = async (url, headers = {}) => {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Endpoint returned HTTP " + response.status);
      return response.json();
    };
    const discovery = await get(issuer + "/.well-known/openid-configuration");
    if (discovery.issuer !== issuer) throw new Error("OIDC discovery issuer mismatch");
    if (typeof discovery.authorization_endpoint !== "string" ||
        typeof discovery.token_endpoint !== "string" ||
        typeof discovery.jwks_uri !== "string") {
      throw new Error("OIDC discovery is missing essential endpoints");
    }
    const jwksUri = new URL(discovery.jwks_uri);
    if (jwksUri.protocol !== "https:") throw new Error("JWKS must be served over HTTPS");
    const jwks = await get(jwksUri);
    if (!Array.isArray(jwks.keys) || !jwks.keys.some(key =>
      typeof key.kid === "string" && ["RS256", "ES256", "EdDSA"].includes(key.alg) ||
      typeof key.kid === "string" && ["RSA", "EC", "OKP"].includes(key.kty)
    )) {
      throw new Error("No usable signing key found in JWKS");
    }
    const projectId = encodeURIComponent(process.env.ZITADEL_TEST_PROJECT_ID);
    const project = await get(base + "/management/v1/projects/" + projectId, {
      authorization: "Bearer " + process.env.ZITADEL_MANAGEMENT_TOKEN,
      "x-zitadel-orgid": process.env.ZITADEL_ORGANIZATION_ID,
    });
    if (project.project?.id !== process.env.ZITADEL_TEST_PROJECT_ID ||
        project.project.projectRoleCheck !== true || project.project.hasProjectCheck !== true) {
      throw new Error("ZITADEL project does not enforce mandatory role/project checks");
    }
    console.log("PASS: issuer/discovery/JWKS and project role-check preflight.");
    console.log("PENDING: browser OIDC code+PKCE, actual signed token aud/roles/iss/sub,");
    console.log("  consent, logout, refresh, two-tenant denial, role revocation and recovery.");
    console.log("Do not activate tenant OIDC based on this preflight alone.");
  } catch (error) {
    console.error("BLOCKED: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  }
}
