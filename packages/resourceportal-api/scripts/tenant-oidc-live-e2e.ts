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
import { ZitadelTenantProjectService } from "../src/tenant-oidc/zitadel-tenant-project.service";
import { ZitadelOAuthApplicationService } from "../src/oauth-applications/zitadel-oauth-application.service";

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
const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const response = await fetch(issuer + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "x-zitadel-orgid": orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Isolated ZITADEL " + route + " returned HTTP " + response.status);
  return response.json() as Promise<T>;
};
const config = { get: (name: string) => process.env[name] } as unknown as ConfigService;
const prisma = new PrismaClient();
const projects = new ZitadelTenantProjectService(config);
const tenants = new TenantOidcService(prisma as unknown as PrismaService, projects, config);
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

async function main() {
  const discovery = await (await fetch(issuer + "/.well-known/openid-configuration")).json() as {
    issuer?: string; jwks_uri?: string; authorization_endpoint?: string; token_endpoint?: string;
  };
  assert.equal(discovery.issuer, issuer, "Issuer must match the live HTTPS discovery document");
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
    const [providerA, providerB] = await Promise.all([
      tenants.provision(tenantA.id), tenants.provision(tenantB.id),
    ]);
    assert.equal(providerA.enabled, false, "Provision must not auto-activate");
    assert.equal(providerB.enabled, false, "Provision must not auto-activate");
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

    await tenants.reconcileGrants(tenantA.id);
    await tenants.reconcileGrants(tenantB.id);
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

    // This enablement exists ONLY in an isolated test subprocess. RP never
    // exports this flag in production or the shared federation workflow.
    process.env.TENANT_OIDC_ACTIVATION_ALLOWED = "true";
    const active = await tenants.activate(tenantA.id);
    assert.equal(active.enabled, true);
    const web = await clients.provision({
      name: "Isolated Web " + suffix, type: "Web",
      redirectUris: ["https://localhost:8443/callback"],
      postLogoutRedirectUris: ["https://localhost:8443/logout"],
    }, projectA);
    assert.ok(web.clientId && web.clientSecret, "Confidential Web client missing its credentials");
    ownedApps.push({ id: web.applicationId, projectId: projectA });
    const spa = await clients.provision({
      name: "Isolated SPA " + suffix, type: "SPA",
      redirectUris: ["https://localhost:8443/callback"],
      postLogoutRedirectUris: [],
    }, projectA);
    assert.ok(spa.clientId && !spa.clientSecret, "SPA must not be given confidential credentials");
    ownedApps.push({ id: spa.applicationId, projectId: projectA });

    await tenants.revokeGrantBeforeMembershipRemoval(tenantA.id, userA.id);
    await prisma.tenantMembership.update({
      where: { userId_tenantId: { userId: userA.id, tenantId: tenantA.id } },
      data: { status: MembershipStatus.Suspended },
    });
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
    console.log("PASS: real HTTPS issuer/discovery/JWKS, two independent projects and client types,");
    console.log("  membership-backed grants, cross-tenant denial and live grant revocation.");
    console.log("PENDING: interactive authorization+PKCE signed token roles, consent, refresh/logout,");
    console.log("  native login recovery and token-expiry revocation E2E are NOT certified by this suite.");
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
