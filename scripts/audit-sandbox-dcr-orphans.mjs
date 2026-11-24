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
    },
    body: JSON.stringify({
      query: { limit: pageSize, offset },
      ...(queries ? { queries } : {}),
    }),
  });
  if (!response.ok) throw Error("Sandbox management search failed with HTTP " + response.status);
  const body = await response.json();
  assert.ok(body && typeof body === "object" && Array.isArray(body.result),
    "Invalid project/app search response");
  const total = Number(body.details?.totalResult);
  assert.ok(body.details?.totalResult !== undefined &&
    Number.isSafeInteger(total) && total >= 0 && total <= pageSize * maxPages,
    "Missing, invalid or oversized management search total");
  assert.ok(body.result.length <= pageSize, "Oversized management search page");
  return { result: body.result, total };
}
async function allPages(path, queries) {
  const collected = [];
  let expectedTotal = null;
  for (let page = 0; page < maxPages; page += 1) {
    const { result, total } = await search(path, page * pageSize, queries);
    if (expectedTotal === null) expectedTotal = total;
    assert.equal(total, expectedTotal, "Inconsistent pagination count; audit is UNKNOWN");
    collected.push(...result);
    assert.ok(collected.length <= total, "Duplicated/oversized search results");
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
