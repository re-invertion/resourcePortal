/**
 * Isolated HTTPS ZITADEL tenant IdP integration. Never run against production.
 * Exercises real management API, RP Prisma state, tenant separation, project
 * grants, OAuth clients and revocation. Token/browser certification is separate.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { MembershipStatus, PrismaClient, UserStatus } from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import { TenantOidcService } from "../src/tenant-oidc/tenant-oidc.service";
import { TenantOidcAutoRolloutService } from "../src/tenant-oidc/tenant-oidc-auto-rollout.service";
import { ZitadelTenantProjectService } from "../src/tenant-oidc/zitadel-tenant-project.service";
import { ZitadelOAuthApplicationService } from "../src/oauth-applications/zitadel-oauth-application.service";
import { runOidcAuthorizationE2E, assertRevokedRefreshCannotAuthorizeTenant } from "./tenant-oidc-browser-e2e";
import { startActionProof } from "./tenant-oidc-actions-v2-proof";
import { McpOAuthDcrService } from "../src/mcp/mcp-oauth-dcr.service";
import { AppConsumersService } from "../src/app-consumers/app-consumers.service";
import { AppConsumerActionService } from "../src/app-consumers/app-consumer-action.service";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing mandatory live E2E variable: " + name);
  return value;
}

const issuer = required("OIDC_ISSUER_URL").replace(/\/$/, "");
// This integration intentionally mutates external ZITADEL resources. Never
// accept an arbitrary live endpoint accidentally supplied from production.
if (issuer !== "https://localhost:8443" ||
    process.env.TENANT_OIDC_E2E_ISOLATED !== "true" ||
    !process.env.NODE_EXTRA_CA_CERTS) {
  throw new Error("Tenant OIDC live E2E requires isolated https://localhost:8443 and test CA");
}
const token = required("ZITADEL_MANAGEMENT_TOKEN");
const orgId = required("ZITADEL_ORGANIZATION_ID");
const api = async <T>(method: string, route: string, body?: unknown, deadline?: number): Promise<T> => {
  const response = await fetch(issuer + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "x-zitadel-orgid": orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(deadline === undefined ? 20000 : Math.max(1, Math.min(20000, Math.ceil(deadline - performance.now())))),
  });
  if (!response.ok) throw new Error("Isolated ZITADEL " + route + " returned HTTP " + response.status);
  return response.json() as Promise<T>;
};
const config = { get: (name: string) => process.env[name] } as unknown as ConfigService;
const prisma = new PrismaClient();
const projects = new ZitadelTenantProjectService(config);
const tenants = new TenantOidcService(prisma as unknown as PrismaService, projects, config);
const autoRollout = new TenantOidcAutoRolloutService(prisma as unknown as PrismaService, tenants, config);
const clients = new ZitadelOAuthApplicationService(config);

async function createZitadelHuman(suffix: string): Promise<string> {
  const answer = await api<{ userId?: string }>("POST", "/management/v1/users/human/_import", {
    userName: "oidc-live-" + suffix,
    profile: { firstName: "Tenant", lastName: "E2E", displayName: "Tenant OIDC live E2E", preferredLanguage: "en" },
    email: { email: "oidc-live-" + suffix + "@example.test", isEmailVerified: true },
    password: "E2e!Test-" + suffix,
    passwordChangeRequired: false,
  });
  assert.match(answer.userId ?? "", /^\d+$/, "ZITADEL returned no native user subject");
  return answer.userId!;
}

/**
 * Isolated real ZITADEL DCR lost-response proof. The harness deliberately
 * retains registration-scoped credentials for an exact test-only cleanup;
 * production orphan recovery without those credentials remains unproven.
 * NEVER send this experiment to a non-local or production issuer.
 */
async function proveDroppedDcrRegistrationResponse() {
  assert.equal(issuer, "https://localhost:8443");
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const originalFetch = globalThis.fetch;
  let accepted: { clientId: string; registrationToken: string } | undefined;
  const testName = "RP isolated DCR dropped response " + randomUUID();
  let ownedAppId: string | undefined;
  let registrationPosts = 0;
  // Anonymous RFC7591 registrations belong to the instance default org,
  // not necessarily the separate RP bootstrap organization.
  const defaultOrg = await api<{ org?: { id?: string } }>("GET", "/admin/v1/orgs/default");
  const dcrOrgId = defaultOrg.org?.id;
  assert.ok(dcrOrgId && /^\d+$/.test(dcrOrgId), "Missing default DCR organization ID");
  console.log("DCR inventory organization matches RP bootstrap: " + (dcrOrgId === orgId));
  const dcrApi = async <T>(route: string, body: unknown, deadline: number): Promise<T> => {
    const remaining = Math.ceil(deadline - performance.now());
    assert.ok(remaining > 0, "DCR inventory deadline exceeded");
    const response = await originalFetch(issuer + route, {
      method: "POST", redirect: "error",
      headers: { authorization: "Bearer " + token, "content-type": "application/json",
        "x-zitadel-orgid": dcrOrgId },
      body: JSON.stringify(body), signal: AbortSignal.timeout(remaining),
    });
    assert.equal(response.status, 200, "DCR management inventory HTTP failure");
    return response.json() as Promise<T>;
  };
  const readDcrInventory = async (deadline: number) => {
    const projects = await dcrApi<{ result?: Array<{ id: string; name: string }>; details?: { totalResult?: string } }>(
      "/management/v1/projects/_search", { query: { limit: 100 },
        queries: [{ nameQuery: { name: "ZITADEL DCR", method: "TEXT_QUERY_METHOD_EQUALS" } }] }, deadline);
    const matches = (projects.result ?? []).filter(project => project.name === "ZITADEL DCR");
    if (matches.length === 0 && Number(projects.details?.totalResult ?? 0) === 0) return null;
    assert.equal(matches.length, 1, "DCR project missing or ambiguous");
    assert.equal(Number(projects.details?.totalResult), 1, "DCR project inventory incomplete");
    type App = { id: string; name?: string; oidcConfig?: { clientId?: string; accessTokenType?: string } };
    const inventory: App[] = [];
    for (let page = 0; page < 20; page++) {
      const response = await dcrApi<{ result?: App[]; details?: { totalResult?: string } }>(
        "/management/v1/projects/" + encodeURIComponent(matches[0].id) + "/apps/_search",
        { query: { limit: 100, offset: page * 100 } }, deadline);
      const rows = response.result ?? [];
      // Protobuf JSON omits zero-valued scalar fields, including totalResult
      // on an empty list. Require the ListDetails envelope nevertheless.
      assert.ok(response.details && Array.isArray(rows), "Missing DCR list details");
      const total = Number(response.details.totalResult ?? 0);
      assert.ok(Number.isSafeInteger(total) && total >= 0 && rows.length <= 100,
        "Invalid DCR application inventory (rows=" + rows.length +
        ", totalPresent=" + (response.details.totalResult !== undefined) + ")");
      inventory.push(...rows);
      if (inventory.length === total) {
        assert.equal(new Set(inventory.map(app => app.id)).size, inventory.length,
          "Duplicate application in DCR inventory");
        return inventory;
      }
      assert.ok(rows.length === 100 && inventory.length < total, "Incomplete DCR application inventory");
    }
    throw new Error("DCR application inventory exceeds test bound");
  };
  let registrationHttpStatus: number | undefined;
  const registerEndpoint = issuer + "/oauth/v2/register";
  // DCR is only advertised when the isolated issuer explicitly enables it.
  // Perform a read-only discovery check; never change issuer settings here.
  const dcrDiscoveryResponse = await originalFetch(issuer + "/.well-known/openid-configuration", {
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  assert.equal(dcrDiscoveryResponse.status, 200, "Isolated issuer discovery unavailable");
  const dcrDiscovery = await dcrDiscoveryResponse.json() as { registration_endpoint?: unknown };
  if (dcrDiscovery.registration_endpoint !== registerEndpoint) {
    throw new Error("Isolated ZITADEL DCR endpoint not advertised; no registration POST sent");
  }
  const cleanupUrl = (clientId: string) => {
    assert.match(clientId, /^[a-zA-Z0-9._~-]{1,128}$/);
    return issuer + "/oauth/v2/register/" + clientId;
  };
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl = typeof input === "string" ? input
      : input instanceof URL ? input.href : input.url;
    if (requestedUrl !== registerEndpoint || init?.method !== "POST") {
      return originalFetch(input, init);
    }
    registrationPosts += 1;
    // The real HTTPS issuer must COMMIT and return 201 before the harness
    // simulates a network loss; a fake/stubbed upstream does not count.
    const response = await originalFetch(input, init);
    registrationHttpStatus = response.status;
    assert.equal(response.status, 201, "Isolated HTTPS ZITADEL rejected real DCR registration");
    const metadata = await response.json() as {
      client_id?: unknown; registration_access_token?: unknown;
    };
    assert.equal(typeof metadata.client_id, "string");
    assert.equal(typeof metadata.registration_access_token, "string");
    accepted = {
      clientId: metadata.client_id as string,
      registrationToken: metadata.registration_access_token as string,
    };
    throw new Error("Synthetic transport failure after actual accepted upstream POST201");
  };
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const config = { get: (key: string) => ({
      ZITADEL_INTERNAL_URL: issuer,
      OIDC_ISSUER_URL: issuer,
      ZITADEL_MANAGEMENT_TOKEN: "unused-for-lost-response-proof",
      ZITADEL_DCR_REQUEST_TIMEOUT_MS: "10000",
      ZITADEL_DCR_REGISTRATION_TIMEOUT_MS: "30000",
    })[key as "ZITADEL_INTERNAL_URL" | "OIDC_ISSUER_URL" |
        "ZITADEL_MANAGEMENT_TOKEN" | "ZITADEL_DCR_REQUEST_TIMEOUT_MS" |
        "ZITADEL_DCR_REGISTRATION_TIMEOUT_MS"] } as ConfigService;
    let publicResult: unknown;
    try {
      await new McpOAuthDcrService(config).register({
        client_name: testName,
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        response_types: ["code"], grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      });
    } catch (failure) {
      publicResult = failure && typeof failure === "object" && "getResponse" in failure
        ? (failure as { getResponse: () => unknown }).getResponse() : failure;
    }
    assert.equal(registrationPosts, 1,
      "MCP DCR test never sent exactly one real registration POST");
    if (registrationHttpStatus !== 201) {
      throw new Error("Actual isolated ZITADEL DCR POST returned HTTP " +
        String(registrationHttpStatus ?? "no-response") + "; no accepted client proof");
    }
    assert.ok(accepted, "Real HTTP201 did not return valid registration metadata");
    assert.equal((publicResult as { code?: string } | undefined)?.code,
      "DCR_REGISTRATION_OUTCOME_UNCERTAIN");
    assert.ok(!JSON.stringify(publicResult).includes(accepted.registrationToken),
      "SECURITY: response exposed a registration bearer token");
    // RFC7592 GET is served from ActiveOIDCClientByID (a read projection),
    // while the accepted registration committed its write to the eventstore.
    // Do not assume projection latency is the cause of an initial 404: record
    // status-only evidence and require actual GET200 within a fixed deadline.
    // 401/403/5xx are not temporary "not yet visible" observations.
    const authHeader = { authorization: "Bearer " + accepted.registrationToken };
    const visibleDeadline = performance.now() + 15000;
    let beforeStatus = 0;
    let observationCount = 0;
    do {
      const remaining = Math.ceil(visibleDeadline - performance.now());
      assert.ok(remaining > 0, "Real DCR orphan visibility deadline exceeded");
      const before = await originalFetch(cleanupUrl(accepted.clientId), {
        method: "GET", headers: authHeader, redirect: "error",
        signal: AbortSignal.timeout(remaining),
      });
      beforeStatus = before.status;
      observationCount++;
      await before.body?.cancel();
      assert.ok(beforeStatus === 200 || beforeStatus === 404,
        "Real DCR orphan visibility returned unexpected HTTP " + beforeStatus);
      if (beforeStatus === 200) break;
      if (performance.now() >= visibleDeadline) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < visibleDeadline);
    assert.equal(beforeStatus, 200,
      "Real DCR orphan not independently observable (HTTP " + beforeStatus +
      ", observations=" + observationCount + ")");
    console.log("PASS: real HTTPS ZITADEL POST201 then simulated lost response => RP uncertain, one POST, read-only orphan GET200 (#213); observations=" + observationCount);
  } catch (failure) {
    primaryFailure = failure;
  } finally {
    globalThis.fetch = originalFetch;
    if (accepted) {
      try {
      // Capture the independent management identity before deleting it.
      // Do not infer ownership from a missing or incomplete inventory.
      const inventoryDeadline = performance.now() + 15000;
      let inventory = await readDcrInventory(inventoryDeadline);
      while ((!inventory || !inventory.some(app => app.oidcConfig?.clientId === accepted!.clientId)) &&
          performance.now() < inventoryDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        inventory = await readDcrInventory(inventoryDeadline);
      }
      assert.ok(inventory, "Default organization DCR project not visible");
      const owned = inventory.filter(app => app.oidcConfig?.clientId === accepted!.clientId);
      assert.equal(owned.length, 1, "Exact DCR app not independently observable before cleanup");
      assert.ok(owned[0].id && owned[0].name?.startsWith(testName + " ("), "DCR app ownership mismatch");
      ownedAppId = owned[0].id;
      // Only this disposable CI-owned client, identified by its exact
      // returned URI-safe ID, may be deleted using its scoped DCR bearer.
      const authHeader = { authorization: "Bearer " + accepted.registrationToken };
      const deleted = await originalFetch(cleanupUrl(accepted.clientId), {
        method: "DELETE", headers: authHeader, redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(deleted.status, 204, "Real test DCR client cleanup was not acknowledged");
      // v4.17.0 RemoveDynamicOIDCClient commits ApplicationRemoved to the
      // eventstore; RFC7592 GET reads ActiveOIDCClientByID and accepts the
      // projected token hash without a write-model lookup on a hash match.
      // A 204 therefore does not establish that the read model has converged.
      // Require BOTH RFC7592 absence and independent management inventory.
      const deadline = performance.now() + 15000;
      let afterStatus = 0;
      let remainingApps = -1;
      do {
        const after = await originalFetch(cleanupUrl(accepted.clientId), {
          method: "GET", headers: authHeader, redirect: "error",
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
        });
        afterStatus = after.status;
        await after.body?.cancel();
        assert.ok([200, 401, 403, 404].includes(afterStatus),
          "Unexpected RFC7592 cleanup read status: " + afterStatus);
        const inventory = await readDcrInventory(deadline);
        assert.ok(inventory, "DCR project disappeared during cleanup verification");
        remainingApps = inventory.filter(app => app.id === ownedAppId ||
          app.oidcConfig?.clientId === accepted!.clientId ||
          app.name?.startsWith(testName + " (")).length;
        if (afterStatus === 404 && remainingApps === 0) break;
        if (performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
      assert.equal(afterStatus, 404, "SECURITY: RFC7592 client not absent after bounded cleanup");
      assert.equal(remainingApps, 0, "SECURITY: DCR application remains in management inventory");
      console.log("PASS: exact DCR DELETE204, RFC7592 GET404 and independent management inventory absent (#213)");
      } catch (failure) {
        cleanupFailure = failure;
      }
    }
  }
  // An unsuccessful proof must not be replaced by a secondary cleanup
  // exception. Conversely, a failed exact-client cleanup must never be
  // discarded just because an earlier assertion also failed.
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure],
      "DCR scenario failed and exact-client cleanup could not be verified");
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure instanceof Error ? cleanupFailure : new Error("DCR cleanup failed");
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure instanceof Error ? primaryFailure : new Error("DCR scenario failed");
  }

  // The lost-response proof deliberately never enters RP's compatibility
  // update. Also test the *real success path*, because anonymous clients are
  // created in the instance default organization, which can differ from RP's
  // bootstrap organization. This entire fixture is disposable GitHub CI.
  const positiveName = "RP isolated DCR JWT compatibility " + randomUUID();
  const positiveConfig = { get: (key: string) => ({
    ZITADEL_INTERNAL_URL: issuer,
    OIDC_ISSUER_URL: issuer,
    ZITADEL_MANAGEMENT_TOKEN: token,
    ZITADEL_DCR_REQUEST_TIMEOUT_MS: "10000",
    ZITADEL_DCR_REGISTRATION_TIMEOUT_MS: "30000",
  })[key as "ZITADEL_INTERNAL_URL" | "OIDC_ISSUER_URL" |
      "ZITADEL_MANAGEMENT_TOKEN" | "ZITADEL_DCR_REQUEST_TIMEOUT_MS" |
      "ZITADEL_DCR_REGISTRATION_TIMEOUT_MS"] } as ConfigService;
  let positive: { clientId: string; registrationToken: string } | undefined;
  let compatibilityFailure: unknown;
  let compatibilityCleanupFailure: unknown;
  try {
    const response = await new McpOAuthDcrService(positiveConfig).register({
      client_name: positiveName,
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      response_types: ["code"], grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(response.status, 201, "Real ZITADEL DCR compatibility registration failed");
    const body = JSON.parse(response.body) as {
      client_id?: string; registration_access_token?: string;
    };
    assert.match(body.client_id ?? "", /^[a-zA-Z0-9._~-]{1,128}$/);
    assert.ok(body.registration_access_token, "Missing scoped DCR registration bearer");
    positive = { clientId: body.client_id!, registrationToken: body.registration_access_token };
    const inventoryDeadline = performance.now() + 15000;
    let app: { id: string; oidcConfig?: { clientId?: string; accessTokenType?: string } } | undefined;
    do {
      const inventory = await readDcrInventory(inventoryDeadline);
      const found = inventory?.filter(item =>
        item.oidcConfig?.clientId === positive!.clientId &&
        item.name?.startsWith(positiveName + " (")) ?? [];
      assert.ok(found.length <= 1, "Ambiguous real DCR compatibility application");
      app = found[0];
      if (app?.oidcConfig?.accessTokenType === "OIDC_TOKEN_TYPE_JWT") break;
      if (performance.now() < inventoryDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < inventoryDeadline);
    assert.ok(app, "Real JWT-compatible DCR application missing from management inventory");
    assert.equal(app.oidcConfig?.accessTokenType, "OIDC_TOKEN_TYPE_JWT",
      "Real DCR client did not persist the JWT access-token setting");
    console.log("PASS: real HTTPS ZITADEL DCR success through RP JWT compatibility, independent JWT management readback (#213)");
  } catch (failure) {
    compatibilityFailure = failure;
  } finally {
    if (positive) {
      try {
        const header = { authorization: "Bearer " + positive.registrationToken };
        const deleted = await originalFetch(cleanupUrl(positive.clientId), {
          method: "DELETE", headers: header, redirect: "error", signal: AbortSignal.timeout(15000),
        });
        assert.equal(deleted.status, 204, "Real DCR compatibility test client cleanup unacknowledged");
        const deadline = performance.now() + 15000;
        let status = 0;
        let remaining = -1;
        do {
          const read = await originalFetch(cleanupUrl(positive.clientId), {
            method: "GET", headers: header, redirect: "error",
            signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
          });
          status = read.status;
          void read.body?.cancel().catch(() => undefined);
          assert.ok([200, 401, 403, 404].includes(status),
            "Unexpected DCR compatibility cleanup verification status: " + status);
          const inventory = await readDcrInventory(deadline);
          assert.ok(inventory, "DCR project disappeared while verifying compatibility cleanup");
          remaining = inventory.filter(app =>
            app.oidcConfig?.clientId === positive!.clientId ||
            app.name?.startsWith(positiveName + " (")).length;
          if (status === 404 && remaining === 0) break;
          if (performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        } while (performance.now() < deadline);
        assert.equal(status, 404, "Real DCR compatibility client still accessible after deletion");
        assert.equal(remaining, 0, "Real DCR compatibility application still present after deletion");
        console.log("PASS: exact successful DCR client removed; GET404 and independent inventory absent (#213)");
      } catch (failure) {
        compatibilityCleanupFailure = failure;
      }
    }
  }
  if (compatibilityFailure !== undefined && compatibilityCleanupFailure !== undefined) {
    throw new AggregateError([compatibilityFailure, compatibilityCleanupFailure],
      "DCR compatibility failed and test-client cleanup could not be verified");
  }
  if (compatibilityCleanupFailure !== undefined) {
    throw compatibilityCleanupFailure instanceof Error ? compatibilityCleanupFailure :
      new Error("DCR compatibility cleanup failed");
  }
  if (compatibilityFailure !== undefined) {
    throw compatibilityFailure instanceof Error ? compatibilityFailure :
      new Error("DCR compatibility registration failed");
  }
}

async function main() {
  const discovery = await (await fetch(issuer + "/.well-known/openid-configuration")).json() as {
    issuer?: string; jwks_uri?: string; authorization_endpoint?: string; token_endpoint?: string;
  };
  assert.equal(discovery.issuer, issuer, "Issuer must match the live HTTPS discovery document");
  assert.ok(discovery.token_endpoint, "ZITADEL discovery did not provide the token endpoint");
  const jwksUri = discovery.jwks_uri;
  if (!jwksUri?.startsWith(issuer)) {
    throw new Error("JWT keys must belong to actual HTTPS issuer");
  }
  const keys = await (await fetch(jwksUri)).json() as { keys?: unknown[] };
  assert.ok((keys.keys?.length ?? 0) > 0, "Actual HTTPS issuer did not advertise JWKS");

  const suffix = randomUUID().slice(0, 12);
  const userAId = await createZitadelHuman(suffix + "-a");
  const userBId = await createZitadelHuman(suffix + "-b");
  const [userA, userB] = await Promise.all([
    prisma.user.create({ data: {
      email: "oidc-live-" + suffix + "-a@rp.invalid", displayName: "RP E2E A", status: UserStatus.Active,
      identities: { create: { providerType: "zitadel", issuer, externalSubject: userAId } },
    } }),
    prisma.user.create({ data: {
      email: "oidc-live-" + suffix + "-b@rp.invalid", displayName: "RP E2E B", status: UserStatus.Active,
      identities: { create: { providerType: "zitadel", issuer, externalSubject: userBId } },
    } }),
  ]);
  const [tenantA, tenantB] = await Promise.all([
    prisma.tenant.create({ data: {
      name: "oidc-live-" + suffix + "-a", displayName: "Isolated A",
      contactEmail: "a@rp.invalid", memberships: {
        create: [{ userId: userA.id, createdBy: userA.id, status: MembershipStatus.Active }],
      },
    } }),
    prisma.tenant.create({ data: {
      name: "oidc-live-" + suffix + "-b", displayName: "Isolated B",
      contactEmail: "b@rp.invalid", memberships: {
        create: [{ userId: userB.id, createdBy: userB.id, status: MembershipStatus.Active }],
      },
    } }),
  ]);
  const ownedApps: Array<{ id: string; projectId: string }> = [];
  const createdTenants = [tenantA.id, tenantB.id];
  try {
    // Preserve the legacy RP member path before the exact-client gate is
    // certified. A role-free/sso-only member must NOT receive a project-wide
    // grant merely because it can authenticate through ZITADEL.
    await prisma.permission.upsert({
      where: { id: "*" }, create: { id: "*" }, update: {},
    });
    await prisma.role.upsert({
      where: { id: "tenant-owner" },
      create: { id: "tenant-owner", name: "Tenant Owner", permissions: ["*"] },
      update: {},
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: "tenant-owner", permissionId: "*" } },
      create: { roleId: "tenant-owner", permissionId: "*" }, update: {},
    });
    const legacyMembers = await Promise.all([
      prisma.tenantMembership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: userA.id, tenantId: tenantA.id } },
        select: { id: true },
      }),
      prisma.tenantMembership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: userB.id, tenantId: tenantB.id } },
        select: { id: true },
      }),
    ]);
    await prisma.membershipRole.createMany({
      data: legacyMembers.map(({ id }) => ({ membershipId: id, roleId: "tenant-owner" })),
      skipDuplicates: true,
    });
    process.env.TENANT_OIDC_AUTO_ROLLOUT = "true";
    // Prove the same zero-touch activation mode used by the real installer.
    process.env.TENANT_OIDC_ACTIVATION_ALLOWED = "auto";
    const initialAutoRollout = await autoRollout.reconcile();
    assert.notEqual(initialAutoRollout.state, "blocked-inbound-federation",
      "Test RP users unexpectedly require incoming federation");
    const [providerA, providerB] = await Promise.all([
      tenants.get(tenantA.id), tenants.get(tenantB.id),
    ]);
    assert.equal(providerA.status, "Active", "Automatic tenant A activation failed");
    assert.equal(providerB.status, "Active", "Automatic tenant B activation failed");
    assert.ok(typeof initialAutoRollout.prepared === "number" && initialAutoRollout.prepared >= 2,
      "Automatic migration did not prepare both tenants");
    assert.equal(initialAutoRollout.state, "active", "One-click rollout did not activate tenants");
    assert.ok(initialAutoRollout.activated >= 2, "One-click rollout did not activate both tenants");
    assert.equal(providerA.enabled, true, "Tenant A must auto-activate after preflight");
    assert.equal(providerB.enabled, true, "Tenant B must auto-activate after preflight");
    assert.deepEqual(await autoRollout.readiness(), { status: "ready" });
    assert.notEqual(providerA.projectId, providerB.projectId, "Tenants share ZITADEL project");
    assert.equal(providerA.issuer, issuer);
    assert.equal(providerB.issuer, issuer);
    const projectA = String(providerA.projectId);
    const projectB = String(providerB.projectId);
    for (const project of [projectA, projectB]) {
      const state = await projects.readProject(project);
      assert.equal(state.hasProjectCheck, true);
      assert.equal(state.projectRoleCheck, true);
    }

    const rowA = await prisma.tenantOidcGrant.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: tenantA.id, userId: userA.id } },
    });
    const rowB = await prisma.tenantOidcGrant.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: tenantB.id, userId: userB.id } },
    });
    assert.notEqual(rowA.zitadelGrantId, rowB.zitadelGrantId);
    assert.equal(rowA.zitadelUserId, userAId);
    assert.equal(rowB.zitadelUserId, userBId);

    const [remoteA, remoteB] = await Promise.all([
      api<{ userGrant: { projectId: string; userId: string; roleKeys: string[] } }>(
        "GET", "/management/v1/users/" + userAId + "/grants/" + rowA.zitadelGrantId),
      api<{ userGrant: { projectId: string; userId: string; roleKeys: string[] } }>(
        "GET", "/management/v1/users/" + userBId + "/grants/" + rowB.zitadelGrantId),
    ]);
    assert.equal(remoteA.userGrant.projectId, projectA);
    assert.equal(remoteA.userGrant.userId, userAId);
    assert.ok(remoteA.userGrant.roleKeys.includes("rp.tenant.member"));
    assert.equal(remoteB.userGrant.projectId, projectB);
    assert.equal(remoteB.userGrant.userId, userBId);
    assert.ok(remoteB.userGrant.roleKeys.includes("rp.tenant.member"));
    const list = await api<{ result?: Array<{ userId?: string; projectId?: string }> }>(
      "POST", "/management/v1/users/grants/_search", { query: { limit: 100 } },
    );
    assert.ok(!list.result?.some(g => g.userId === userAId && g.projectId === projectB),
      "Tenant A user has a role grant in Tenant B project");
    assert.ok(!list.result?.some(g => g.userId === userBId && g.projectId === projectA),
      "Tenant B user has a role grant in Tenant A project");

    // Tenant OIDC is active *without* manually invoking activate().
    const active = await tenants.get(tenantA.id);
    assert.equal(active.enabled, true);
    const web = await clients.provision({
      name: "Isolated Web " + suffix, type: "Web",
      redirectUris: ["http://127.0.0.1:8765/oidc/callback"],
      postLogoutRedirectUris: ["https://localhost:8443/logout"],
    }, projectA);
    assert.ok(web.clientId && web.clientSecret, "Confidential Web client missing its credentials");
    ownedApps.push({ id: web.applicationId, projectId: projectA });
    const liveLogin = await runOidcAuthorizationE2E({
      issuer, projectId: projectA, foreignProjectId: projectB, clientId: web.clientId,
      clientSecret: web.clientSecret, userId: userAId,
      userName: "oidc-live-" + suffix + "-a", password: "E2e!Test-" + suffix + "-a",
      assertCodeReplayDenied: true,
    });
    // #498: prove repeated *fresh* confidential Web authorization requests,
    // distinct codes/states and separate successful token exchanges. A 200
    // discovery response or one successful browser redirect is insufficient.
    for (let replay = 0; replay < 2; replay += 1) {
      await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: web.clientId, clientSecret: web.clientSecret,
        userId: userAId, userName: "oidc-live-" + suffix + "-a",
        password: "E2e!Test-" + suffix + "-a",
      });
    }
    console.log("PASS: three fresh confidential Web PKCE code exchanges and signed tokens on tenant A (#498)");
    const spa = await clients.provision({
      name: "Isolated SPA " + suffix, type: "SPA",
      redirectUris: ["https://localhost:8443/callback"],
      postLogoutRedirectUris: [],
    }, projectA);
    assert.ok(spa.clientId && !spa.clientSecret, "SPA must not be given confidential credentials");
    ownedApps.push({ id: spa.applicationId, projectId: projectA });

    // SECURITY PROOF (#398): same ZITADEL project, two distinct OAuth client
    // IDs, and a separate project/user. No real RP App User grant is created.
    // A real V2 preaccesstoken webhook must DENY the revoked client's refresh,
    // but never deny the still-allowed first client or foreign tenant.
    const secondWeb = await clients.provision({
      name: "Client-scoped Web " + suffix, type: "Web",
      redirectUris: ["http://127.0.0.1:8765/oidc/callback"],
      postLogoutRedirectUris: ["https://localhost:8443/logout"],
    }, projectA);
    assert.ok(secondWeb.clientId && secondWeb.clientSecret);
    ownedApps.push({ id: secondWeb.applicationId, projectId: projectA });
    const foreignWeb = await clients.provision({
      name: "Separate tenant Web " + suffix, type: "Web",
      redirectUris: ["http://127.0.0.1:8765/oidc/callback"],
      postLogoutRedirectUris: ["https://localhost:8443/logout"],
    }, projectB);
    assert.ok(foreignWeb.clientId && foreignWeb.clientSecret);
    ownedApps.push({ id: foreignWeb.applicationId, projectId: projectB });
    const foreignDeniedWeb = await clients.provision({
      name: "Second tenant scoped Web " + suffix, type: "Web",
      redirectUris: ["http://127.0.0.1:8765/oidc/callback"],
      postLogoutRedirectUris: ["https://localhost:8443/logout"],
    }, projectB);
    assert.ok(foreignDeniedWeb.clientId && foreignDeniedWeb.clientSecret);
    ownedApps.push({ id: foreignDeniedWeb.applicationId, projectId: projectB });

    const gate = await startActionProof({ api, issuer, testUserId: userAId, testProjectId: projectA });
    try {
      // Do not use the initial login's refresh token here: it has already
      // completed RP-initiated logout in the pre-existing E2E.
      const separateAllowed = await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: web.clientId, clientSecret: web.clientSecret,
        userId: userAId, userName: "oidc-live-" + suffix + "-a",
        password: "E2e!Test-" + suffix + "-a", skipLogout: true,
      });
      const scoped = await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: secondWeb.clientId, clientSecret: secondWeb.clientSecret,
        userId: userAId, userName: "oidc-live-" + suffix + "-a",
        password: "E2e!Test-" + suffix + "-a", skipLogout: true,
      });
      assert.ok(gate.events().some(e => e.userId === userAId && e.clientId === secondWeb.clientId &&
        e.decision === "allow"), "ZITADEL did not expose exact client_id at token issuance");
      gate.denyClient(secondWeb.clientId);
      const before = gate.events().length;
      const deniedRefresh = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(
            secondWeb.clientId + ":" + secondWeb.clientSecret,
          ).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: scoped.refreshToken,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      assert.ok(!deniedRefresh.ok,
        "SECURITY: ZITADEL reissued an access token after exact OAuth client was denied");
      assert.ok(gate.events().slice(before).some(e =>
        e.userId === userAId && e.clientId === secondWeb.clientId && e.decision === "deny"),
      "SECURITY: denied refresh did not trigger a client-aware preaccesstoken callback");

      // The original (different) OAuth client in the SAME ZITADEL project must
      // continue working, with no project-wide authorization regression.
      // Do not mistake events from its earlier code exchange/first refresh
      // for proof that THIS allowed refresh traversed the signed Action.
      const beforeAllowedRefresh = gate.events().length;
      const allowedRefresh = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(web.clientId + ":" + web.clientSecret).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: separateAllowed.refreshToken,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(allowedRefresh.status, 200,
        "Revoking client B unexpectedly revoked separate client A in same project");
      const rotated = await allowedRefresh.json() as {
        access_token?: string; refresh_token?: string;
      };
      assert.ok(rotated.access_token, "Allowed client refresh returned no access token");
      separateAllowed.refreshToken = rotated.refresh_token ?? separateAllowed.refreshToken;
      assert.ok(gate.events().slice(beforeAllowedRefresh).some(e =>
        e.userId === userAId && e.clientId === web.clientId && e.decision === "allow"),
      "Allowed client refresh did not invoke the signed Action for that refresh request");

      await runOidcAuthorizationE2E({
        issuer, projectId: projectB, foreignProjectId: projectA,
        clientId: foreignWeb.clientId, clientSecret: foreignWeb.clientSecret,
        userId: userBId, userName: "oidc-live-" + suffix + "-b",
        password: "E2e!Test-" + suffix + "-b",
      });
      assert.ok(gate.events().some(e => e.userId === userBId &&
        e.clientId === foreignWeb.clientId && e.decision === "allow"),
      "Foreign tenant OIDC token issuer stopped working");
      console.log("PASS: isolated signed Action V2 exact-client refresh denial, " +
        "same-project allow and independent-tenant allow");
    } finally {
      await gate.close();
    }

    // Unified #430 test: one member and grant rows, four real ZITADEL
    // OAuth client IDs in two separate tenant projects, signed Actions V2
    // preaccesstoken on real OAuth refresh. Unlike the preceding #404 proof,
    // authorization decisions come from the production Prisma-backed service.
    const consumerService = new AppConsumersService(prisma as unknown as PrismaService);
    const members = await Promise.all([
      prisma.tenantMembership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: userA.id, tenantId: tenantA.id } },
      }),
      prisma.tenantMembership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: userB.id, tenantId: tenantB.id } },
      }),
    ]);
    const apps = await Promise.all([
      { remote: web, tenantId: tenantA.id, projectId: projectA, actorId: userA.id, name: "Consumer A allowed" },
      { remote: secondWeb, tenantId: tenantA.id, projectId: projectA, actorId: userA.id, name: "Consumer A denied" },
      { remote: foreignWeb, tenantId: tenantB.id, projectId: projectB, actorId: userB.id, name: "Consumer B allowed" },
      { remote: foreignDeniedWeb, tenantId: tenantB.id, projectId: projectB, actorId: userB.id, name: "Consumer B denied" },
    ].map(({ remote, tenantId, projectId, actorId, name }) =>
      prisma.oAuthApplication.create({ data: {
        tenantId, name, type: "Web",
        redirectUris: ["http://127.0.0.1:8765/oidc/callback"],
        postLogoutRedirectUris: ["https://localhost:8443/logout"],
        zitadelApplicationId: remote.applicationId,
        zitadelProjectId: projectId, clientId: remote.clientId,
        createdBy: actorId, updatedBy: actorId,
      } }),
    ));
    // Obtain refresh tokens while these are still ordinary tenant members.
    // Once the exact-client gate is bound, these ungranted clients are denied
    // even though a valid refresh token was obtained before policy activation.
    const denyAToken = await runOidcAuthorizationE2E({
      issuer, projectId: projectA, foreignProjectId: projectB,
      clientId: secondWeb.clientId, clientSecret: secondWeb.clientSecret,
      userId: userAId, userName: "oidc-live-" + suffix + "-a",
      password: "E2e!Test-" + suffix + "-a", skipLogout: true,
    });
    const denyBToken = await runOidcAuthorizationE2E({
      issuer, projectId: projectB, foreignProjectId: projectA,
      clientId: foreignDeniedWeb.clientId, clientSecret: foreignDeniedWeb.clientSecret,
      userId: userBId, userName: "oidc-live-" + suffix + "-b",
      password: "E2e!Test-" + suffix + "-b", skipLogout: true,
    });

    // #430: a person is not an App User account category. Authorize existing
    // tenant members independently from their RP management roles.
    await prisma.role.upsert({
      where: { id: "sso-login" },
      create: { id: "sso-login", name: "SSO Login (no ResourcePortal permissions)", permissions: [] },
      update: {},
    });
    await prisma.membershipRole.createMany({
      data: members.map(member => ({ membershipId: member.id, roleId: "sso-login" })),
      skipDuplicates: true,
    });
    const nativeWeb = await prisma.tenantNativeAppGrant.create({ data: {
      membershipId: members[0].id, tenantId: tenantA.id, clientKey: "web",
      createdBy: userA.id, updatedBy: userA.id,
    } });
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userAId, "web"), true);
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userAId, "cli"), false);
    await prisma.tenantNativeAppGrant.update({
      where: { id: nativeWeb.id }, data: { enabled: false, updatedBy: userA.id },
    });
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userAId, "web"), false);
    const grantedA = await prisma.tenantAppClientGrant.create({ data: {
      membershipId: members[0].id, tenantId: tenantA.id,
      oauthApplicationId: apps[0].id, createdBy: userA.id, updatedBy: userA.id,
    } });
    await prisma.tenantAppClientGrant.create({ data: {
      membershipId: members[1].id, tenantId: tenantB.id,
      oauthApplicationId: apps[2].id, createdBy: userB.id, updatedBy: userB.id,
    } });

    // Matrix: A can use only tenant-A client 1, B only tenant-B client 1.
    // All other 6 subject/client combinations must fail closed. No test-only
    // grant matrix substitutes for these actual persisted records.
    for (const [subject, allowedClient] of [
      [userAId, web.clientId],
      [userBId, foreignWeb.clientId],
    ] as const) {
      for (const client of [web, secondWeb, foreignWeb, foreignDeniedWeb]) {
        assert.equal(
          await consumerService.mayIssueClientToken(issuer, subject, client.clientId),
          client.clientId === allowedClient,
          "SECURITY: isolated unified SSO exact subject/client/tenant grant mismatch",
        );
      }
    }
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userAId, "web"), false);
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userBId, "web"), false);

    // The live target's signing key is returned by ZITADEL at creation.
    // Use exactly that key for the production validator, not a fixture secret.
    let currentSigningKey = "";
    const actionConfig = { get: (key: string) => ({
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: currentSigningKey,
      OIDC_ISSUER_URL: issuer,
      OIDC_CLIENT_ID: "rp-native-client-not-in-this-e2e",
    } as Record<string, string>)[key] } as unknown as ConfigService;
    // Existing integration exercises tenant application grants, not ChatGPT
    // DCR. Keep an explicit fail-closed verifier for the newer constructor.
    const realAuthorization = new AppConsumerActionService(
      actionConfig, consumerService,
      { isTrustedChatGptClient: () => Promise.resolve(false) } as never,
    );
    const consumerGate = await startActionProof({
      api, issuer, testUserId: userAId, testProjectId: projectA,
      targetName: "rp-398-real-prisma-client-grants-" + suffix,
      async authorize(raw, signature, signingKey) {
        currentSigningKey = signingKey;
        try {
          await realAuthorization.authorize(raw, signature);
        } catch (error) {
          // Diagnostics are intentionally restricted to this disposable CI
          // issuer and a fixed whitelist of server-authored messages; never
          // print webhook bodies, signing keys, client IDs or user identities.
          const payload = JSON.parse(raw.toString("utf8")) as {
            function?: string;
            user?: { id?: string };
            application?: { client_id?: string };
          };
          const reason = error instanceof Error && [
            "App Consumer authorization target disabled",
            "App Consumer target signing key unavailable",
            "Invalid ZITADEL Action signature",
            "Invalid Action payload",
            "Unsupported Action function",
            "ZITADEL Action user or client identity missing",
            "Issuer not configured",
            "OIDC client access denied",
            "RP native login denied",
          ].includes(error.message) ? error.message : "unclassified-denial";
          const knownAllowed =
            (payload.user?.id === userAId && payload.application?.client_id === web.clientId) ||
            (payload.user?.id === userBId && payload.application?.client_id === foreignWeb.clientId);
          if (knownAllowed && payload.user?.id && payload.application?.client_id) {
            const grant = await consumerService.mayIssueClientToken(
              issuer, payload.user.id, payload.application.client_id,
            ).catch(() => null);
            console.error("Isolated App Consumer expected-allow rejected:",
              { reason, expectedFunction: payload.function === "function/preaccesstoken",
                currentGrant: grant });
          }
          throw error;
        }
      },
    });
    const refreshClient = async (clientId: string, clientSecret: string, refreshToken: string) =>
      fetch(discovery.token_endpoint!, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
    let suspendedB = false;
    try {
      // #463: simulate the actual delay between the local exact-client
      // entitlement and assignment of a native tenant project grant, using
      // a NEW sso-login-only member (no RP management permissions).
      // Upstream assignment is deliberately held until readiness is observed
      // pending; the already certified real Actions V2 execution remains live.
      const userCId = await createZitadelHuman(suffix + "-c");
      const userC = await prisma.user.create({ data: {
        email: "oidc-live-" + suffix + "-c@rp.invalid",
        displayName: "RP Delayed SSO E2E",
        status: UserStatus.Active,
        identities: { create: { providerType: "zitadel", issuer, externalSubject: userCId } },
      } });
      const memberC = await prisma.tenantMembership.create({ data: {
        tenantId: tenantA.id, userId: userC.id, createdBy: userA.id,
        status: MembershipStatus.Active,
        roles: { create: [{ roleId: "sso-login" }] },
      } });
      const onlyA = await prisma.tenantAppClientGrant.create({ data: {
        tenantId: tenantA.id, membershipId: memberC.id,
        oauthApplicationId: apps[0].id, createdBy: userA.id, updatedBy: userA.id,
      } });
      // RP's per-client Action alone would approve A, but ZITADEL's native
      // project check does not yet have the corresponding membership grant.
      assert.equal(await consumerService.mayIssueClientToken(issuer, userCId, web.clientId), true);
      assert.equal(await consumerService.mayIssueClientToken(issuer, userCId, secondWeb.clientId), false);
      assert.deepEqual(await tenants.memberReadiness(tenantA.id, userC.id),
        { status: "pending", reason: "UPSTREAM_GRANT_PENDING" });
      // Controlled barrier release: real Management API persists the missing
      // role assignment. This proves readiness against the actual issuer,
      // not against mocked verification or merely an RP local grant.
      const remoteGrantC = await projects.assignMember(userCId, projectA);
      const grantC = await prisma.tenantOidcGrant.create({ data: {
        tenantId: tenantA.id, userId: userC.id, zitadelUserId: userCId,
        zitadelGrantId: remoteGrantC, status: "Active",
      } });
      assert.deepEqual(await tenants.memberReadiness(tenantA.id, userC.id), { status: "ready" });
      const issuedC = await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: web.clientId, clientSecret: web.clientSecret,
        userId: userCId, userName: "oidc-live-" + suffix + "-c",
        password: "E2e!Test-" + suffix + "-c", skipLogout: true,
      });
      const renewedC = await refreshClient(web.clientId, web.clientSecret, issuedC.refreshToken);
      assert.equal(renewedC.status, 200, "Newly provisioned user C could not refresh allowed client A");
      const tokenC = await renewedC.json() as { refresh_token?: string };
      assert.ok(tokenC.refresh_token);
      assert.ok(consumerGate.events().some(e => e.userId === userCId &&
        e.clientId === web.clientId && e.decision === "allow"));
      // A and B share tenant project, but only A is entitled for C.
      assert.equal(await consumerService.mayIssueClientToken(issuer, userCId, secondWeb.clientId), false);
      await prisma.tenantAppClientGrant.update({
        where: { id: onlyA.id }, data: { enabled: false, updatedBy: userA.id },
      });
      const cRevoked = await refreshClient(web.clientId, web.clientSecret, tokenC.refresh_token);
      assert.ok(!cRevoked.ok, "SECURITY: newly onboarded SSO-only client access survived revocation");
      assert.ok(consumerGate.events().some(e => e.userId === userCId &&
        e.clientId === web.clientId && e.decision === "deny"));
      // Removing the real remote grant must withdraw readiness even while
      // RP still has a locally Active grant row.
      await projects.revokeMember(userCId, remoteGrantC);
      assert.deepEqual(await tenants.memberReadiness(tenantA.id, userC.id),
        { status: "pending", reason: "UPSTREAM_GRANT_UNVERIFIED" });
      await prisma.tenantOidcGrant.delete({ where: { id: grantC.id } });
      console.log("PASS: #463 real delayed SSO-only member: pending before grant, " +
        "native verified ready, client A token, B denied, revocation and remote-loss pending");

      // Real signed approval for both isolated tenants.
      const allowA = await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: web.clientId, clientSecret: web.clientSecret,
        userId: userAId, userName: "oidc-live-" + suffix + "-a",
        password: "E2e!Test-" + suffix + "-a", skipLogout: true,
      });
      const allowB = await runOidcAuthorizationE2E({
        issuer, projectId: projectB, foreignProjectId: projectA,
        clientId: foreignWeb.clientId, clientSecret: foreignWeb.clientSecret,
        userId: userBId, userName: "oidc-live-" + suffix + "-b",
        password: "E2e!Test-" + suffix + "-b", skipLogout: true,
      });
      const allowARefresh = await refreshClient(web.clientId, web.clientSecret, allowA.refreshToken);
      assert.equal(allowARefresh.status, 200, "Authorized tenant A client refresh failed");
      const rotatedA = await allowARefresh.json() as { refresh_token?: string };
      assert.ok(rotatedA.refresh_token, "ZITADEL did not issue a rotated allowed-A refresh token");
      const allowBRefresh = await refreshClient(foreignWeb.clientId, foreignWeb.clientSecret, allowB.refreshToken);
      assert.equal(allowBRefresh.status, 200, "Authorized tenant B client refresh failed");
      const rotatedB = await allowBRefresh.json() as { refresh_token?: string };
      assert.ok(rotatedB.refresh_token, "ZITADEL did not issue a rotated allowed-B refresh token");

      // A GLOBAL interrupting target that stops answering must block even
      // an otherwise entitled client, rather than silently issuing a refresh
      // token without RP authorization. This is why staging/rollback of the
      // target cannot be an unconditional installer upgrade step.
      let safelyRotatedA = rotatedA.refresh_token;
      consumerGate.simulateOutage(true);
      try {
        const eventOffset = consumerGate.events().length;
        const outage = await refreshClient(web.clientId, web.clientSecret, safelyRotatedA);
        assert.ok(!outage.ok,
          "SECURITY: ZITADEL minted a token while the global Actions V2 webhook failed");
        assert.ok(consumerGate.events().slice(eventOffset).some(event =>
          event.userId === userAId && event.clientId === web.clientId &&
          event.decision === "deny"),
        "SECURITY: outage did not reach the signed blocking Action target");
      } finally {
        consumerGate.simulateOutage(false);
      }
      // Recover using a fresh Authorization Code+PKCE flow: a failed refresh
      // may already have been consumed or rotated by the issuer.
      const recoveredA = await runOidcAuthorizationE2E({
        issuer, projectId: projectA, foreignProjectId: projectB,
        clientId: web.clientId, clientSecret: web.clientSecret,
        userId: userAId, userName: "oidc-live-" + suffix + "-a",
        password: "E2e!Test-" + suffix + "-a", skipLogout: true,
      });
      const afterRecovery = await refreshClient(
        web.clientId, web.clientSecret, recoveredA.refreshToken);
      assert.equal(afterRecovery.status, 200,
        "Authorized refresh remained unavailable after the global webhook recovered");
      const recoveredATokens = await afterRecovery.json() as { refresh_token?: string };
      assert.ok(recoveredATokens.refresh_token,
        "ZITADEL did not issue a rotated refresh after restoring the global callback");
      safelyRotatedA = recoveredATokens.refresh_token;
      console.log("PASS: signed global preaccesstoken target outage denies valid refresh, recovery restores authorization");

      for (const [remote, tokenResult] of [
        [secondWeb, denyAToken], [foreignDeniedWeb, denyBToken],
      ] as const) {
        assert.ok(remote.clientSecret, "Live Web OAuth client must have a secret");
        const response = await refreshClient(
          remote.clientId, remote.clientSecret, tokenResult.refreshToken,
        );
        assert.ok(!response.ok, "SECURITY: ungranted App Consumer client refreshed successfully");
        assert.ok(consumerGate.events().some(event =>
          event.clientId === remote.clientId && event.decision === "deny"),
        "SECURITY: ungranted client refresh bypassed the signed Actions V2 policy");
      }
      for (const clientId of [web.clientId, foreignWeb.clientId]) {
        assert.ok(consumerGate.events().some(event =>
          event.clientId === clientId && event.decision === "allow"),
        "SECURITY: valid App Consumer client did not traverse signed Actions V2");
      }

      // Revocation must stop fresh tokens, not only hide a UI grant.
      await prisma.tenantAppClientGrant.update({
        where: { id: grantedA.id }, data: { enabled: false, updatedBy: userA.id },
      });
      assert.equal(await consumerService.mayIssueClientToken(issuer, userAId, web.clientId), false);
      const beforeRevoked = consumerGate.events().length;
      const revoked = await refreshClient(web.clientId, web.clientSecret, safelyRotatedA);
      assert.ok(!revoked.ok, "SECURITY: RP grant revocation allowed token refresh");
      assert.ok(consumerGate.events().slice(beforeRevoked).some(event =>
        event.clientId === web.clientId && event.userId === userAId && event.decision === "deny"),
      "SECURITY: revoked grant did not deny its freshly rotated refresh in signed Actions V2");

      await prisma.tenantMembership.update({
        where: { id: members[1].id }, data: { status: MembershipStatus.Suspended },
      });
      suspendedB = true;
      assert.equal(await consumerService.mayIssueClientToken(issuer, userBId, foreignWeb.clientId), false);
      const beforeSuspended = consumerGate.events().length;
      const suspended = await refreshClient(foreignWeb.clientId, foreignWeb.clientSecret, rotatedB.refresh_token);
      assert.ok(!suspended.ok, "SECURITY: suspended consumer refreshed OAuth token");
      assert.ok(consumerGate.events().slice(beforeSuspended).some(event =>
        event.clientId === foreignWeb.clientId && event.userId === userBId && event.decision === "deny"),
      "SECURITY: suspended consumer did not deny its rotated refresh in signed Actions V2");

      console.log("PASS: real signed production App Consumer authorization, 2 users x 2 client IDs per tenant x 2 tenants; revoke and suspended refresh denied.");
    } finally {
      if (suspendedB) {
        await prisma.tenantMembership.update({
          where: { id: members[1].id }, data: { status: MembershipStatus.Active },
        });
      }
      await consumerGate.close();
    }

    await tenants.revokeGrantBeforeMembershipRemoval(tenantA.id, userA.id);
    await prisma.tenantMembership.update({
      where: { userId_tenantId: { userId: userA.id, tenantId: tenantA.id } },
      data: { status: MembershipStatus.Suspended },
    });
    await assertRevokedRefreshCannotAuthorizeTenant(liveLogin);
    assert.equal((await tenants.get(tenantA.id)).enabled, false,
      "Tenant IdP must fail closed after revocation");
    const revoked = await fetch(issuer + "/management/v1/users/" + userAId +
      "/grants/" + rowA.zitadelGrantId, { headers: {
      authorization: "Bearer " + token, "x-zitadel-orgid": orgId,
    } });
    assert.equal(revoked.status, 404, "Revoked ZITADEL grant remains usable");
    const stillB = await api<{ userGrant: { projectId: string } }>(
      "GET", "/management/v1/users/" + userBId + "/grants/" + rowB.zitadelGrantId,
    );
    assert.equal(stillB.userGrant.projectId, projectB, "Tenant A revocation harmed Tenant B");
    await proveDroppedDcrRegistrationResponse();
    console.log("PASS: real HTTPS issuer/discovery/JWKS, two independent projects and client types,");
    console.log("  membership-backed grants, cross-tenant denial and live grant revocation.");
    console.log("PENDING: production migration certification, RP Web/CLI live refresh and MFA/recovery,");
    console.log("  formal consent coverage and already-issued token expiry are not certified by this suite.");
  } finally {
    for (const app of ownedApps.reverse()) {
      await clients.delete(app.id, app.projectId).catch(() => undefined);
    }
    for (const tenantId of createdTenants) {
      await tenants.delete(tenantId).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}
void main().catch(err => {
  console.error("BLOCKED: isolated tenant OIDC live integration failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
