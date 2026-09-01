import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const statePath = resolve(
  process.env.FEDERATION_E2E_STATE_FILE ?? "var/federation/state.json",
);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const apiOrigin = process.env.FEDERATION_E2E_RP_ORIGIN ?? "http://localhost:3000";
const webOrigin = process.env.FEDERATION_E2E_WEB_ORIGIN ?? "http://localhost:4173";
const keycloakOrigin =
  process.env.FEDERATION_E2E_KEYCLOAK_ORIGIN ?? "http://localhost:8180";
const zitadelOrigin =
  process.env.FEDERATION_E2E_ZITADEL_ORIGIN ?? "http://localhost:8080";
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const stamp = Date.now();
  const appGroupName = `web-e2e-${stamp}`;
  const singleAppName = `web-e2e-app-${stamp}`;
  const variableName = `WEB_E2E_VAR_${stamp}`;
  const configName = `web-e2e-config-${stamp}`;
  const secretName = `web-e2e-secret-${stamp}`;
  const sensitivePayloadValue = `opaque-value-${stamp}`;
  const oauthApplicationName = `web-e2e-oauth-${stamp}`;
  const serviceIdentityName = `web-e2e-service-${stamp}`;
  const groupName = `web-e2e-group-${stamp}`;

  try {
    await page.goto(
      `${webOrigin}/login?tenantId=${encodeURIComponent(state.tenantId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await page.getByRole("button", { name: "Tenant Keycloak OIDC" }).click();
    await routeToKeycloak(page, "Tenant Keycloak OIDC");

    await page.locator("#username").fill(state.oidcUser.username);
    await page.locator("#password").fill(state.oidcUser.password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator("#kc-login").click(),
    ]);

    await finishZitadelLogin(page);

    const meResponse = await context.request.get(`${webOrigin}/api/auth/me`);
    const meText = await meResponse.text();
    assert(
      meResponse.ok(),
      `Web proxy did not accept the RP session: ${meResponse.status()} ${meText}`,
    );
    const me = JSON.parse(meText);
    assert(
      me.email === state.oidcUser.email,
      `Unexpected Web session email ${me.email}`,
    );

    const identity = await prisma.userIdentity.findFirst({
      where: {
        email: state.oidcUser.email,
        identityProviderId: state.oidcProviderId,
      },
    });
    assert(identity, "Web login did not create the expected UserIdentity");

    const membership = await prisma.tenantMembership.upsert({
      where: {
        userId_tenantId: {
          userId: identity.userId,
          tenantId: state.tenantId,
        },
      },
      update: { status: "Active" },
      create: {
        userId: identity.userId,
        tenantId: state.tenantId,
        status: "Active",
        createdBy: identity.userId,
      },
    });
    await prisma.membershipRole.upsert({
      where: {
        membershipId_roleId: {
          membershipId: membership.id,
          roleId: "tenant-owner",
        },
      },
      update: {},
      create: {
        membershipId: membership.id,
        roleId: "tenant-owner",
      },
    });

    const deepLink = `${webOrigin}/tenants/${encodeURIComponent(state.tenantId)}/overview`;
    const deepLinkResponse = await context.request.get(deepLink);
    const deepLinkHtml = await deepLinkResponse.text();
    assert(
      deepLinkResponse.status() === 200,
      `Tenant deep-link returned ${deepLinkResponse.status()}`,
    );
    assert(
      deepLinkHtml.includes('data-route-kind="tenant"') &&
        deepLinkHtml.includes(`data-tenant-id="${state.tenantId}"`),
      "Tenant deep-link was not server-rendered with tenant route metadata",
    );

    await page.goto(deepLink, { waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "Tenant overview" }).waitFor();
    await page.locator("main section pre").first().waitFor();
    assert(
      (await page.getByRole("alert").count()) === 0,
      "Tenant overview rendered an error alert",
    );

    await navigateTenantSection(page, "app-groups", "AppGroups");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "AppGroups" }).waitFor();
    await waitForPageRequests(page, "app-groups");

    const appGroupsSection = panelByHeading(page, "AppGroups");
    await createResource(appGroupsSection, { name: appGroupName });

    const createdRow = page.getByRole("row").filter({ hasText: appGroupName });
    await createdRow.waitFor();
    await createdRow.getByRole("link", { name: "Open" }).click();
    await page.waitForURL(
      new RegExp(`/tenants/${state.tenantId}/app-groups/[0-9a-f-]+$`),
    );
    await page.locator("main > h1", { hasText: "AppGroup" }).waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "AppGroup" }).waitFor();
    await waitForPageRequests(page, "app-group-detail");

    const singleAppsPanel = panelByHeading(page, "SingleApps");
    await createResource(singleAppsPanel, {
      name: singleAppName,
      description: "Stage 20 browser E2E SingleApp",
      image: "nginx:alpine",
      desiredReplicas: 0,
      cpu: 0.1,
      memoryBytes: 134217728,
    });
    const singleAppRow = page.getByRole("row").filter({ hasText: singleAppName });
    await singleAppRow.waitFor();
    const singleAppId = (await singleAppRow.locator("td").first().textContent())?.trim();
    assert(singleAppId, "SingleApp create did not expose an id in the resource table");

    const variablesPanel = panelByHeading(page, "Variables");
    await createResource(variablesPanel, {
      name: variableName,
      description: "Stage 20 browser E2E variable",
      value: "browser-e2e-value",
    });
    const variableRow = page.getByRole("row").filter({ hasText: variableName });
    await variableRow.waitFor();

    const configsPanel = panelByHeading(page, "Configs");
    await createResource(configsPanel, {
      name: configName,
      description: "Stage 20 browser E2E config",
      content: "feature=true\n",
    });
    const configRow = page.getByRole("row").filter({ hasText: configName });
    await configRow.waitFor();

    const secretsPanel = panelByHeading(page, "Secrets");
    await createResource(secretsPanel, {
      name: secretName,
      description: "Stage 20 browser E2E secret metadata",
      type: "Text",
      value: sensitivePayloadValue,
    });
    const secretRow = page.getByRole("row").filter({ hasText: secretName });
    await secretRow.waitFor();
    assert(
      !(await secretRow.textContent())?.includes(sensitivePayloadValue),
      "Secret plaintext leaked into the Web resource table after create/read",
    );

    await page.getByLabel("SingleApp ID").fill(singleAppId);
    const endpointsPanel = panelByHeading(page, "HTTP endpoints");
    await createResource(endpointsPanel, {
      name: "web",
      containerPort: 8080,
      protocolMode: "HTTP",
    });
    const endpointRow = endpointsPanel.getByRole("row").filter({ hasText: "web" });
    await endpointRow.waitFor();
    await deleteResourceRow(endpointRow);

    await deleteResourceRow(variableRow);
    await deleteResourceRow(configRow);
    await deleteResourceRow(secretRow);
    await deleteResourceRow(singleAppRow);

    await navigateTenantSection(page, "app-groups", "AppGroups");
    const cleanupRow = page.getByRole("row").filter({ hasText: appGroupName });
    await cleanupRow.waitFor();
    await deleteResourceRow(cleanupRow);

    const routeMatrix = [
      ["volumes", "Volumes"],
      ["registries", "Registries"],
      ["domains", "Domains and HTTP routing"],
      ["administration", "Tenant administration"],
      ["credentials", "Tenant machine credentials"],
      ["billing", "Billing and quota"],
      ["audit", "Audit log"],
      ["operations", "Operations / jobs"],
    ];

    for (const [section, heading] of routeMatrix) {
      await navigateTenantSection(page, section, heading);
      await waitForPageRequests(page, section);
      assert(
        (await page.getByRole("alert").count()) === 0,
        `Tenant ${section} route rendered an API error alert`,
      );
    }

    await navigateTenantSection(page, "administration", "Tenant administration");
    await waitForPageRequests(page, "administration");
    const groupsPanel = panelByHeading(page, "Groups");
    await createResource(groupsPanel, {
      name: groupName,
      description: "Stage 20 browser E2E group",
    });
    let groupRow = page.getByRole("row").filter({ hasText: groupName });
    await groupRow.waitFor();
    await groupRow.locator("summary", { hasText: "Patch" }).click();
    await groupRow
      .getByRole("textbox", { name: "JSON payload" })
      .fill(JSON.stringify({ description: "Stage 20 browser E2E group updated" }, null, 2));
    await groupRow.getByRole("button", { name: "Save", exact: true }).click();
    groupRow = page.getByRole("row").filter({ hasText: groupName });
    await groupRow.waitFor();
    await deleteResourceRow(groupRow);

    const authPolicySection = panelByHeading(page, "Authentication policy");
    await authPolicySection
      .getByRole("textbox", { name: "JSON payload" })
      .fill(
        JSON.stringify(
          {
            allowPlatformLogin: false,
            allowTenantIdentityProviders: true,
            requireTenantIdentityProvider: true,
          },
          null,
          2,
        ),
      );
    await authPolicySection.getByRole("button", { name: "Save", exact: true }).click();
    assert(
      (await authPolicySection.getByRole("alert").count()) === 0,
      "Authentication policy update rendered an error",
    );

    await navigateTenantSection(page, "credentials", "Tenant machine credentials");
    await waitForPageRequests(page, "credentials");

    const oauthPanel = panelByHeading(page, "OAuth applications");
    await createResource(oauthPanel, {
      name: oauthApplicationName,
      type: "Machine",
      redirectUris: [],
      postLogoutRedirectUris: [],
    });
    let oauthRow = page.getByRole("row").filter({ hasText: oauthApplicationName });
    await oauthRow.waitFor();
    let oauthCredential = oauthPanel.locator('section[aria-label="One-time credential"]');
    await oauthCredential.waitFor();
    assert(
      (await oauthCredential.textContent())?.includes("clientSecret"),
      "OAuthApplication create did not expose its one-time clientSecret",
    );
    await oauthCredential.getByRole("button", { name: "Clear credential" }).click();
    await oauthCredential.waitFor({ state: "detached" });
    await oauthRow.getByRole("button", { name: "Rotate credentials" }).click();
    oauthCredential = oauthPanel.locator('section[aria-label="One-time credential"]');
    await oauthCredential.waitFor();
    assert(
      (await oauthCredential.textContent())?.includes("clientSecret"),
      "OAuthApplication rotation did not expose a one-time clientSecret",
    );
    oauthRow = page.getByRole("row").filter({ hasText: oauthApplicationName });
    await oauthRow.waitFor();
    await deleteResourceRow(oauthRow);

    const servicePanel = panelByHeading(page, "Service identities");
    await createResource(servicePanel, {
      name: serviceIdentityName,
      description: "Stage 20 browser E2E identity",
      roleIds: ["viewer"],
    });

    let createdIdentityRow = page
      .getByRole("row")
      .filter({ hasText: serviceIdentityName });
    await createdIdentityRow.waitFor();
    let oneTimeCredential = servicePanel.locator(
      'section[aria-label="One-time credential"]',
    );
    await oneTimeCredential.waitFor();
    assert(
      (await oneTimeCredential.textContent())?.includes("clientSecret"),
      "ServiceIdentity create did not expose its one-time clientSecret",
    );

    await oneTimeCredential
      .getByRole("button", { name: "Clear credential" })
      .click();
    await oneTimeCredential.waitFor({ state: "detached" });
    await createdIdentityRow
      .getByRole("button", { name: "Rotate credentials" })
      .click();
    oneTimeCredential = servicePanel.locator(
      'section[aria-label="One-time credential"]',
    );
    await oneTimeCredential.waitFor();
    assert(
      (await oneTimeCredential.textContent())?.includes("clientSecret"),
      "ServiceIdentity rotation did not expose a one-time clientSecret",
    );

    createdIdentityRow = page
      .getByRole("row")
      .filter({ hasText: serviceIdentityName });
    await createdIdentityRow.waitFor();
    await deleteResourceRow(createdIdentityRow);

    await navigateTenantSection(page, "billing", "Billing and quota");
    await waitForPageRequests(page, "billing");
    const quotaSection = panelByHeading(page, "Quota");
    await quotaSection
      .getByRole("textbox", { name: "JSON payload" })
      .fill(JSON.stringify({ maxSingleApps: 100, maxVolumes: 100 }, null, 2));
    await quotaSection.getByRole("button", { name: "Save", exact: true }).click();
    assert(
      (await quotaSection.getByRole("alert").count()) === 0,
      "Quota update rendered an error",
    );

    await navigateTenantSection(page, "audit", "Audit log");
    await waitForPageRequests(page, "audit");
    await page
      .getByRole("textbox", { name: "JSON payload" })
      .fill(JSON.stringify({ limit: 10 }, null, 2));
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByRole("button", { name: "Export" }).click();
    await page.locator("details", { hasText: "Export output" }).waitFor();
    assert(
      (await page.getByRole("alert").count()) === 0,
      "Audit filter/export rendered an error",
    );

    const storageKeys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    assert(
      storageKeys.every(
        (key) => !/(token|session|secret|credential)/i.test(key),
      ),
      `Web Console persisted auth-like browser storage keys: ${storageKeys.join(", ")}`,
    );

    console.log(
      `Stage 20 Web Console browser E2E passed for tenant ${state.tenantId}`,
    );
  } catch (error) {
    const snapshot = await page.content().catch(() => "<page unavailable>");
    console.error(`Stage 20 Web Console E2E failed at ${page.url()}`);
    console.error(snapshot.slice(0, 8_000));
    throw error;
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  await prisma.$disconnect();
}

function panelByHeading(page, heading) {
  const title = page.getByRole("heading", { name: heading, level: 2 });
  return title.locator("xpath=parent::header/parent::section");
}

async function createResource(panel, body) {
  await panel.locator("summary", { hasText: "Create" }).click();
  await panel
    .getByRole("textbox", { name: "JSON payload" })
    .fill(JSON.stringify(body, null, 2));
  await panel.getByRole("button", { name: "Create", exact: true }).click();
}

async function deleteResourceRow(row) {
  pageDialogAccept(row.page());
  await row.getByRole("button", { name: "Delete" }).click();
  await row.waitFor({ state: "detached" });
}

function pageDialogAccept(page) {
  page.once("dialog", (dialog) => dialog.accept());
}

async function navigateTenantSection(page, section, heading) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: section, exact: true })
    .click();
  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/${section}$`),
  );
  await page.locator("main > h1", { hasText: heading }).waitFor();
}

async function waitForPageRequests(page, section) {
  await page.waitForFunction(() => {
    const loading = [...document.querySelectorAll("p")].some(
      (element) => element.textContent?.trim() === "Loading…",
    );
    return !loading;
  });
  assert(
    (await page.getByRole("alert").count()) === 0,
    `Tenant ${section} route did not settle cleanly`,
  );
}

async function routeToKeycloak(page, providerLabel) {
  const keycloak = new URL(keycloakOrigin);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = new URL(page.url());
    if (current.origin === keycloak.origin) return;

    const providerControl = page.getByText(providerLabel, { exact: false }).first();
    if (
      (await providerControl.count()) > 0 &&
      (await providerControl.isVisible().catch(() => false))
    ) {
      await providerControl.click();
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `ZITADEL did not redirect to tenant provider; current URL: ${page.url()}`,
  );
}

async function finishZitadelLogin(page) {
  const api = new URL(apiOrigin);
  const zitadel = new URL(zitadelOrigin);
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === api.origin) return;

    if (current.origin === zitadel.origin) {
      const skipMfa = page.locator(
        'form[action="/ui/login/mfa/prompt"] button[name="skip"][value="true"]',
      );
      if (
        (await skipMfa.count()) > 0 &&
        (await skipMfa.isVisible().catch(() => false))
      ) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          skipMfa.click(),
        ]);
        continue;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Web login did not return to Resource Portal API; current URL: ${page.url()}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
