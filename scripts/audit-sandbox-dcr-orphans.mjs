#!/usr/bin/env node
// Read-only incident reconciliation for the existing RP sandbox DCR project.
// This NEVER registers, modifies or deletes a ZITADEL client.
import assert from "node:assert/strict";

const issuer = "https://auth-sandbox.resource-portal.pl";
const prefix = "RP sandbox scoped DCR verify ";
const token = process.env.ZITADEL_SANDBOX_AUDIT_TOKEN;
if (!token || token.includes("\n") || token.includes("\r")) {
  console.error("BLOCKED: supply an independently authorized ZITADEL_SANDBOX_AUDIT_TOKEN.");
  process.exit(2);
}
const pageSize = 100;
const maxPages = 20;
let verifiedDefaultOrgId;
// Anonymous RFC7591 clients are owned by ZITADEL's *instance default org*,
// which may be different from the management token's organization. Without
// the authoritative scope an empty inventory is not credible orphan evidence.
// ZITADEL Admin GetDefaultOrg requires iam.read; fail closed if absent.
async function defaultDcrOrgId() {
  const response = await fetch(issuer + "/admin/v1/orgs/default", {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: {
      authorization: "Bearer " + token,
      "x-zitadel-instance-host": "auth-sandbox.resource-portal.pl",
      "x-zitadel-public-host": "auth-sandbox.resource-portal.pl",
    },
  });
  if (response.status !== 200) {
    throw Error("Cannot verify sandbox default DCR organization: HTTP " + response.status);
  }
  const text = await response.text();
  assert.ok(text.length <= 65536, "Oversized default-organization response");
  let body;
  try { body = JSON.parse(text); }
  catch { throw Error("Invalid default-organization response"); }
  const id = body?.org?.id;
  assert.ok(typeof id === "string" && /^\d+$/.test(id),
    "Missing numeric sandbox default-organization ID");
  return id;
}
async function search(path, offset, queries) {
  const response = await fetch(issuer + path, {
    method: "POST", // search API only: never creates/updates a resource
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "x-zitadel-instance-host": "auth-sandbox.resource-portal.pl",
      "x-zitadel-public-host": "auth-sandbox.resource-portal.pl",
      "x-zitadel-orgid": verifiedDefaultOrgId,
    },
    body: JSON.stringify({
      query: { limit: pageSize, offset },
      ...(queries ? { queries } : {}),
    }),
  });
  if (!response.ok) throw Error("Sandbox management search failed with HTTP " + response.status);
  const body = await response.json();
  assert.ok(body && typeof body === "object" && !Array.isArray(body) &&
    body.details && typeof body.details === "object" &&
    (body.result === undefined || Array.isArray(body.result)),
    "Invalid project/app search response");
  // Protobuf JSON omits default-valued repeated fields and scalar zero
  // totals. Treat an absent count as zero ONLY with an explicit ListDetails
  // envelope and an empty row set; fail closed if any row is present.
  const result = body.result ?? [];
  const rawTotal = body.details.totalResult;
  assert.ok(rawTotal !== undefined || result.length === 0,
    "Missing nonzero management search total; audit is UNKNOWN");
  const total = Number(rawTotal ?? 0);
  assert.ok(Number.isSafeInteger(total) && total >= 0 && total <= pageSize * maxPages,
    "Missing, invalid or oversized management search total");
  assert.ok(result.length <= pageSize, "Oversized management search page");
  return { result, total };
}
async function allPages(path, queries) {
  const collected = [];
  const observedIds = new Set();
  let expectedTotal = null;
  for (let page = 0; page < maxPages; page += 1) {
    const { result, total } = await search(path, page * pageSize, queries);
    if (expectedTotal === null) expectedTotal = total;
    assert.equal(total, expectedTotal, "Inconsistent pagination count; audit is UNKNOWN");
    for (const item of result) {
      assert.ok(item && typeof item.id === "string" && item.id.length > 0,
        "Incomplete management identity; audit is UNKNOWN");
      assert.ok(!observedIds.has(item.id),
        "Repeated management identity across pages; audit is UNKNOWN");
      observedIds.add(item.id);
      collected.push(item);
    }
    assert.ok(collected.length <= total, "Oversized search results; audit is UNKNOWN");
    if (collected.length === total) return collected;
    assert.ok(result.length === pageSize, "Incomplete search page; audit is UNKNOWN");
  }
  throw Error("Maximum pagination limit exceeded; audit is UNKNOWN");
}
try {
  const discovery = await fetch(issuer + "/.well-known/openid-configuration", {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10000),
  });
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json();
  assert.equal(metadata.issuer, issuer, "Wrong sandbox issuer");
  assert.equal(metadata.registration_endpoint, issuer + "/oauth/v2/register",
    "Unexpected DCR endpoint");
  verifiedDefaultOrgId = await defaultDcrOrgId();
  const projects = await allPages("/management/v1/projects/_search",
    [{ nameQuery: { name: "ZITADEL DCR", method: "TEXT_QUERY_METHOD_EQUALS" } }]);
  const dcr = projects.filter(p => p.name === "ZITADEL DCR" && typeof p.id === "string");
  assert.equal(dcr.length, 1, "Could not uniquely identify the ZITADEL DCR project");
  const apps = await allPages("/management/v1/projects/" +
    encodeURIComponent(dcr[0].id) + "/apps/_search");
  const matches = apps.filter(app =>
    typeof app.name === "string" && app.name.startsWith(prefix));
  console.log(JSON.stringify({
    environment: "existing-sandbox-only", project: "ZITADEL DCR",
    auditedApplications: apps.length,
    matchingCandidates: matches.map(app => ({
      applicationId: typeof app.id === "string" ? app.id : null,
      clientId: typeof app.oidcConfig?.clientId === "string"
        ? app.oidcConfig.clientId : null,
      name: app.name,
    })),
    note: "READ-ONLY SNAPSHOT; never infer deletion or non-registration from an empty result. Reconcile audit timeline and independently verify.",
  }, null, 2));
  if (matches.length > 0) process.exitCode = 3; // explicit incident attention needed
} catch (error) {
  console.error("BLOCKED: sandbox DCR inventory is UNKNOWN:", error.message);
  process.exitCode = 1;
}
