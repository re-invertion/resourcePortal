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
    });
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

    // Full #398 test: real RP app consumer and grant rows, four real ZITADEL
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
    // Once App Consumer records are created, these clients are unauthorized
    // and even the initial OAuth code exchange must be denied. This setup
    // deliberately precedes both consumer enrollment and Actions V2 target.
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

    await Promise.all(members.map((member, index) => prisma.tenantAppConsumer.create({ data: {
      tenantId: index === 0 ? tenantA.id : tenantB.id,
      membershipId: member.id, createdBy: index === 0 ? userA.id : userB.id,
    } })));
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
          "SECURITY: isolated App Consumer exact subject/client/tenant grant mismatch",
        );
      }
    }
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userAId), false);
    assert.equal(await consumerService.mayIssueNativeRpToken(issuer, userBId), false);

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
    const realAuthorization = new AppConsumerActionService(actionConfig, consumerService);
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
              { reason, expectedFunction: payload.function === undefined ||
                  payload.function === "preaccesstoken", currentGrant: grant });
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
      const revoked = await refreshClient(web.clientId, web.clientSecret, rotatedA.refresh_token);
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
    console.log("PASS: real HTTPS issuer/discovery/JWKS, two independent projects and client types,");
    console.log("  membership-backed grants, cross-tenant denial and live grant revocation.");
    console.log("PENDING: safe migration of all actual RP login accounts, production MFA/recovery,");
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
