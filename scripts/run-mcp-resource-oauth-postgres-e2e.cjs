#!/usr/bin/env node
"use strict";
/**
 * Exact-code OAuth/MCP + RBAC test against a NEW disposable PostgreSQL 17.
 * Only GitHub-hosted CI is allowed. No customer credentials, live tokens,
 * external network, or shared databases are used.
 *
 * Tests production-compiled services and actual Prisma transactions, not
 * mocked storage. Retained only as CI output: never log issued secrets.
 */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { Reflector } = require("@nestjs/core");
const { REQUIRED_PERMISSIONS_KEY } = require("../packages/resourceportal-api/dist/src/auth/auth.constants.js");
const { McpResourceOAuthService } = require("../packages/resourceportal-api/dist/src/auth/mcp-resource-oauth.service.js");
const { McpUpstreamLoginService } = require("../packages/resourceportal-api/dist/src/auth/mcp-upstream-login.service.js");
const { OidcIssuerTransport } = require("../packages/resourceportal-api/dist/src/auth/oidc-issuer-transport.js");
const { McpResourceOAuthController } = require("../packages/resourceportal-api/dist/src/mcp/mcp-resource-oauth.controller.js");
const { TenantMcpSettingsService } = require("../packages/resourceportal-api/dist/src/mcp/tenant-mcp-settings.service.js");
const { TenantMcpAccessGuard } = require("../packages/resourceportal-api/dist/src/mcp/tenant-mcp-access.guard.js");
const { TenantContextGuard } = require("../packages/resourceportal-api/dist/src/auth/tenant-context.guard.js");
const { PermissionsGuard } = require("../packages/resourceportal-api/dist/src/auth/permissions.guard.js");

const dbUrl = new URL(process.env.DATABASE_URL || "https://invalid.invalid/");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Requires GitHub Actions");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Requires disposable hosted runner");
assert.equal(process.env.RP_MCP_POSTGRES_E2E_ISOLATED, "true", "Requires explicit isolated gate");
assert.equal(dbUrl.hostname, "localhost", "Never connect to remote or shared PostgreSQL");
assert.equal(dbUrl.port, "55433", "Never connect to shared database port");
assert.equal(dbUrl.pathname, "/rp532_mcp_test", "Requires disposable DB name");
assert.equal(dbUrl.protocol, "postgresql:", "Requires PostgreSQL");
const origin = "https://rp532.synthetic.test";
assert.equal(process.env.PUBLIC_API_URL, origin);
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const V = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MAB = "99999999-9999-4999-8999-999999999999";
const verifier = "R".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const prisma = new PrismaClient();
const config = { get: (key, fallback) => ({
  PUBLIC_API_URL: origin, RP_MCP_RESOURCE_OAUTH_ENABLED: "true",
  AUTH_MODE: "oidc", NODE_ENV: "test",
})[key] ?? fallback };
const nativeMode = { isNativeOnly: async () => false };
const settings = new TenantMcpSettingsService(prisma, config, {});
const oauth = new McpResourceOAuthService(config, prisma, {});
const controller = new McpResourceOAuthController(
  oauth, settings, prisma, nativeMode, config, {}, {}, {},
);
const resourceGuard = new TenantMcpAccessGuard(settings, config, prisma, nativeMode);
const reflector = new Reflector();
const tenantGuard = new TenantContextGuard(reflector, prisma, config, nativeMode);
const permissionGuard = new PermissionsGuard(reflector);
const formRequest = { headers: { "content-type": "application/x-www-form-urlencoded" } };
const userA = { id: U, email: "user-a@example.invalid", displayName: "Synthetic A", status: "Active" };
const userB = { id: V, email: "user-b@example.invalid", displayName: "Synthetic B", status: "Active" };
const resource = id => origin + "/api/tenants/" + id + "/mcp";
function reply() {
  return { code: 0, body: undefined, header() { return this; },
    status(value) { this.code = value; return this; },
    send(value) { this.body = value; return this; } };
}
async function token(body) {
  const response = reply();
  await controller.token(body, formRequest, response);
  return response;
}
async function issue(clientId, tenantId, user) {
  const code = await oauth.issueCode({
    tenantId, clientId, redirectUri: callback, challenge,
    scope: "mcp offline_access", user,
  });
  const response = await token({
    grant_type: "authorization_code", client_id: clientId,
    redirect_uri: callback, code, code_verifier: verifier,
    resource: resource(tenantId),
  });
  assert.equal(response.code, 200);
  assert.ok(response.body.access_token && response.body.refresh_token);
  return response.body;
}
async function refresh(clientId, value, tenantId = A) {
  return token({ grant_type: "refresh_token", client_id: clientId,
    refresh_token: value, resource: resource(tenantId) });
}
function context(request, required, path) {
  const handler = () => {};
  Reflect.defineMetadata(REQUIRED_PERMISSIONS_KEY, required, handler);
  request.url = "/api/tenants/" + request.params.tenantId + path;
  return { getHandler: () => handler, getClass: () => class SyntheticEndpoint {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) };
}
async function resourceCall(accessToken, tenantId) {
  const user = await oauth.authenticateAccessToken(accessToken, tenantId);
  const request = { params: { tenantId },
    headers: { authorization: "Bearer " + accessToken }, user };
  await resourceGuard.canActivate(context(request, [], "/mcp"));
  return user;
}
async function rpPermission(accessToken, tenantId, required, path) {
  const user = await oauth.authenticateAccessToken(accessToken, tenantId);
  const request = { params: { tenantId },
    headers: { authorization: "Bearer " + accessToken }, user };
  const ctx = context(request, required, path);
  await tenantGuard.canActivate(ctx);
  return permissionGuard.canActivate(ctx);
}
async function seed() {
  const migrations = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  const expectedMigrations = require("node:fs").readdirSync(
    "packages/resourceportal-api/prisma/migrations", { withFileTypes: true },
  ).filter(entry => entry.isDirectory()).length;
  assert.equal(migrations[0].count, expectedMigrations, "All current migrations must apply");
  assert.equal(await prisma.tenant.count(), 0, "Test database must start empty");
  await prisma.user.createMany({ data: [userA, userB] });
  await prisma.tenant.createMany({ data: [
    { id: A, name: "synthetic-a", displayName: "Synthetic A", contactEmail: "nobody@example.invalid" },
    { id: B, name: "synthetic-b", displayName: "Synthetic B", contactEmail: "nobody@example.invalid" },
  ] });
  // Existing migrations may already seed platform-wide core roles and permissions.
  await prisma.role.upsert({
    where: { id: "sso-login" },
    create: { id: "sso-login", name: "SSO login", permissions: [] },
    update: {},
  });
  await prisma.permission.createMany({ data: [
    { id: "appgroup.read" }, { id: "appgroup.deploy" },
  ], skipDuplicates: true });
  await prisma.role.create({ data: {
    id: "mcp-synthetic-reader", name: "MCP synthetic restricted role",
    // Intentionally stale legacy wildcard must NOT affect normalized RBAC.
    permissions: ["*"],
    permissionBindings: { create: [{ permissionId: "appgroup.read" }] },
  } });
  for (const [id, tenantId, userId, reader] of [
    [MA, A, U, true], [MB, B, V, false], [MAB, B, U, false],
  ]) {
    await prisma.tenantMembership.create({ data: {
      id, tenantId, userId, createdBy: U, status: "Active",
      roles: { create: [
        { roleId: "sso-login" },
        ...(reader ? [{ roleId: "mcp-synthetic-reader" }] : []),
      ] },
    } });
  }
  for (const [tenantId, ids] of [[A, [MA]], [B, [MB, MAB]]]) {
    await prisma.tenantMcpSettings.create({ data: {
      tenantId, enabled: true, accessMode: "SelectedMembers", updatedBy: U,
      allowedMembers: { create: ids.map(membershipId => ({ membershipId })) },
    } });
  }
}
// Production service, real separate Prisma connections and real committed
// PostgreSQL state. Only the external non-idempotent provider response is
// synthesized here; the pinned real provider is tested in the HTTPS job.
async function proveIdentityRegistrationReservation() {
  const issuer = "https://rp532-identity.synthetic.test";
  const identityConfig = { get: key => ({
    OIDC_ISSUER_URL: issuer,
    RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
    RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
  })[key] };
  const oidc = { getDiscovery: async () => ({
    authorizationEndpoint: issuer + "/oauth/v2/authorize",
    tokenEndpoint: issuer + "/oauth/v2/token",
    registrationEndpoint: issuer + "/oauth/v2/register",
  }) };
  const encryption = { encrypt: () => "synthetic-sealed-verifier" };
  const replica = new PrismaClient();
  const makeService = db => new McpUpstreamLoginService(db, identityConfig, oidc, encryption);
  // Use the real RP registration service so the login row has a valid FK.
  const registered = await oauth.registerClient({ redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const input = tenantId => ({ tenantId, clientId: registered.client_id, resource: resource(tenantId),
    redirectUri: callback, challenge, clientState: "synthetic-state", scope: "mcp offline_access" });
  const originalFetch = OidcIssuerTransport.prototype.fetch;
  let dispatched = 0;
  let release, entered, first;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const hasCode = code => error => error?.getResponse?.()?.code === code;
  try {
    OidcIssuerTransport.prototype.fetch = async (url, stage) => {
      assert.equal(String(url), issuer + "/oauth/v2/register");
      assert.equal(stage, "registration");
      dispatched++;
      if (dispatched === 1) {
        entered(); await barrier;
        return Response.json({ client_id: "532000001", token_endpoint_auth_method: "none",
          redirect_uris: [origin + "/api/mcp/oauth/upstream/callback"] }, { status: 201 });
      }
      if (dispatched === 2) throw new Error("synthetic response lost after possible acceptance");
      throw new Error("unexpected duplicate registration POST");
    };
    first = makeService(prisma).start(input(A), origin);
    await Promise.race([started, first.then(() => { throw new Error("reservation did not hold provider request"); })]);
    await assert.rejects(() => makeService(replica).start(input(A), origin),
      hasCode("MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED"));
    assert.equal(dispatched, 1);
    release();
    await first;
    await makeService(replica).start(input(A), origin);
    assert.equal(dispatched, 1);
    assert.equal((await replica.mcpOAuthUpstreamClient.findUnique({ where: { tenantId: A } })).clientId, "532000001");
    const bound = await replica.mcpOAuthUpstreamRegistration.findUnique({ where: { tenantId: A } });
    assert.equal(bound.status, "Bound");
    assert.equal(bound.observedClientId, "532000001");
    await assert.rejects(() => makeService(prisma).start(input(B), origin),
      hasCode("MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN"));
    const restarted = new PrismaClient();
    try {
      await assert.rejects(() => makeService(restarted).start(input(B), origin),
        hasCode("MCP_IDENTITY_DCR_RECONCILIATION_REQUIRED"));
      assert.equal(dispatched, 2);
      assert.equal((await restarted.mcpOAuthUpstreamRegistration.findUnique({ where: { tenantId: B } })).status, "Uncertain");
      assert.equal(await restarted.mcpOAuthUpstreamClient.findUnique({ where: { tenantId: B } }), null);
      assert.equal(await restarted.mcpOAuthGrant.count(), 0);
    } finally { await restarted.$disconnect(); }
    console.log("PASS real PostgreSQL durable per-tenant identity DCR reservation: replica race, restart, uncertain outcome, no additional provider POST, no grant mutation");
  } finally {
    release();
    if (first) await first.catch(() => undefined);
    OidcIssuerTransport.prototype.fetch = originalFetch;
    await replica.$disconnect();
  }
}
async function run() {
  await seed();
  await proveIdentityRegistrationReservation();
  const clientA = (await oauth.registerClient({ redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })).client_id;
  const clientB = (await oauth.registerClient({ redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })).client_id;

  const a1 = await issue(clientA, A, userA);
  const b1 = await issue(clientB, B, userB);
  assert.equal((await resourceCall(a1.access_token, A)).id, U);
  assert.equal((await resourceCall(b1.access_token, B)).id, V);
  await assert.rejects(() => resourceCall(a1.access_token, B));
  await assert.rejects(() => resourceCall(b1.access_token, A));
  console.log("PASS real PostgreSQL + RP OAuth: 2 users / 2 tenants, signed-in grants bound to correct resource");

  assert.equal(await rpPermission(a1.access_token, A, ["appgroup.read"], "/app-groups"), true);
  await assert.rejects(() =>
    rpPermission(a1.access_token, A, ["appgroup.deploy"], "/app-groups/fake/deploy"),
    err => err.getStatus?.() === 403,
  );
  await assert.rejects(() =>
    rpPermission(a1.access_token, B, ["appgroup.read"], "/app-groups"),
  );
  console.log("PASS real RBAC: restricted read allowed, deploy denied, cross-tenant denied");

  const invalidResource = await refresh(clientA, a1.refresh_token, B);
  assert.equal(invalidResource.code, 400);
  assert.equal(invalidResource.body.error, "invalid_target");
  const a2 = await refresh(clientA, a1.refresh_token);
  assert.equal(a2.code, 200);
  assert.equal(await prisma.mcpOAuthSpentRefreshToken.count(), 1);
  console.log("PASS persisted refresh rotation and wrong-resource refresh rejection");

  await prisma.tenantMcpMemberAccess.deleteMany({ where: { tenantId: A } });
  await assert.rejects(() => resourceCall(a2.body.access_token, A), err => err.getStatus?.() === 403);
  await assert.rejects(() => refresh(clientA, a2.body.refresh_token), err => err.getStatus?.() === 403);
  console.log("PASS removing MCP allowlist immediately blocks tool calls and token refresh");

  await prisma.tenantMcpMemberAccess.create({ data: { tenantId: A, membershipId: MA } });
  const oldReplay = await refresh(clientA, a1.refresh_token);
  assert.equal(oldReplay.code, 400);
  assert.equal(oldReplay.body.error, "invalid_grant");
  await assert.rejects(() => resourceCall(a2.body.access_token, A));
  assert.equal((await refresh(clientA, a2.body.refresh_token)).code, 400);
  assert.equal((await resourceCall(b1.access_token, B)).id, V);
  console.log("PASS replayed ancestor revokes latest A tokens without revoking unrelated client B");

  const a3 = await issue(clientA, A, userA);
  const revoke = reply();
  await controller.revoke({ token: a3.refresh_token, client_id: clientA }, formRequest, revoke);
  assert.equal(revoke.code, 200);
  await assert.rejects(() => resourceCall(a3.access_token, A));
  assert.equal((await refresh(clientA, a3.refresh_token)).code, 400);
  console.log("PASS explicit OAuth revoke blocks access and refresh");

  const a4 = await issue(clientA, A, userA);
  await prisma.membershipRole.delete({ where: { membershipId_roleId: {
    membershipId: MA, roleId: "mcp-synthetic-reader",
  } } });
  await assert.rejects(() =>
    rpPermission(a4.access_token, A, ["appgroup.read"], "/app-groups"),
    err => err.getStatus?.() === 403,
  );
  await prisma.membershipRole.delete({ where: { membershipId_roleId: {
    membershipId: MA, roleId: "sso-login",
  } } });
  await assert.rejects(() => resourceCall(a4.access_token, A), err => err.getStatus?.() === 403);
  await assert.rejects(() => refresh(clientA, a4.refresh_token), err => err.getStatus?.() === 403);
  console.log("PASS role removal denies RP tools; SSO role revocation denies MCP and refresh");

  await prisma.membershipRole.create({ data: { membershipId: MA, roleId: "sso-login" } });
  await prisma.tenantMembership.update({ where: { id: MA }, data: { status: "Suspended" } });
  await assert.rejects(() => resourceCall(a4.access_token, A), err => err.getStatus?.() === 403);
  await assert.rejects(() => refresh(clientA, a4.refresh_token), err => err.getStatus?.() === 403);
  console.log("PASS suspended member cannot call MCP tools or refresh tokens");

  // Prove the next denial is caused ONLY by tenant MCP disablement:
  // the member, sso-login role, allow-list and grant must all be valid.
  await prisma.tenantMembership.update({ where: { id: MA }, data: { status: "Active" } });
  await settings.assertUserCanUseMcp(A, U);
  assert.equal((await resourceCall(a4.access_token, A)).id, U);
  const stillValidRefresh = await refresh(clientA, a4.refresh_token);
  assert.equal(stillValidRefresh.code, 200);
  assert.equal((await resourceCall(stillValidRefresh.body.access_token, A)).id, U);
  await prisma.tenantMcpSettings.update({ where: { tenantId: A }, data: { enabled: false } });
  await assert.rejects(() => settings.assertUserCanUseMcp(A, U), err => err.getStatus?.() === 403);
  await assert.rejects(
    () => resourceCall(stillValidRefresh.body.access_token, A),
    err => err.getStatus?.() === 403,
  );
  await assert.rejects(
    () => refresh(clientA, stillValidRefresh.body.refresh_token),
    err => err.getStatus?.() === 403,
  );
  assert.equal((await resourceCall(b1.access_token, B)).id, V);
  console.log("PASS tenant MCP disablement alone denies previously valid member tool and refresh; B remains authorized");

  assert.equal(await prisma.tenant.count(), 2);
  assert.equal(await prisma.user.count(), 2);
  console.log("PASS: all evidence from synthetic test identities, never from customer data");
}
async function cleanup() {
  await prisma.mcpOAuthClient.deleteMany();
  await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
  // Leave migration-provisioned core role/permission catalog untouched.
  await prisma.role.deleteMany({ where: { id: "mcp-synthetic-reader" } });
}
(async () => {
  try {
    await run();
  } finally {
    await cleanup();
  }
})().catch(error => {
  // Never print bearer tokens, raw HTTP bodies or credentials.
  console.error("BLOCKED isolated OAuth/RBAC DB test:", error.name, error.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
