import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { prepareStage20PlatformAdmin } from "./stage20-platform-admin-fixture.mjs";

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
  const appGroupName = `v019-e2e-${stamp}`;
  const applicationName = `web-${stamp}`;

  try {
    await prepareStage20PlatformAdmin({
      prisma,
      state,
      zitadelOrigin,
    });

    await loginThroughFinalUi(page);
    await verifyWebSession(context);
    await ensureTenantOwnerMembership();

    await openTenantDashboard(page);
    await createAppGroup(page, appGroupName);

    const appGroupId = appGroupIdFromUrl(page.url());
    assert(appGroupId, `App Group route did not expose an id: ${page.url()}`);

    await createApplication(page, appGroupId, applicationName);
    await verifyApplicationDetailAndEdit(page, applicationName);
    await deleteAppGroupThroughFinalDialog(page, appGroupId, appGroupName);

    console.log(
      `v0.1.9 final UI browser E2E passed for tenant ${state.tenantId}`,
    );
  } catch (error) {
    const snapshot = await page.content().catch(() => "<page unavailable>");
    console.error(`v0.1.9 final UI E2E failed at ${page.url()}`);
    console.error(snapshot.slice(0, 8_000));
    throw error;
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  await prisma.$disconnect();
}

async function loginThroughFinalUi(page) {
  await page.goto(
    `${webOrigin}/login?tenantId=${encodeURIComponent(state.tenantId)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Sign in" }).waitFor();

  const provider = page.getByRole("button", {
    name: "Tenant Keycloak OIDC",
  });
  await provider.waitFor();

  // dispatchEvent intentionally does not wait for the complete external
  // federation redirect chain. The helper below follows the live browser
  // state until Keycloak is reached.
  await provider.dispatchEvent("click");
  await routeToKeycloak(page, "Tenant Keycloak OIDC");

  await page.locator("#username").fill(state.oidcUser.username);
  await page.locator("#password").fill(state.oidcUser.password);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.locator("#kc-login").click(),
  ]);

  await finishZitadelLogin(page);
}

async function verifyWebSession(context) {
  const response = await context.request.get(`${webOrigin}/api/auth/me`);
  const text = await response.text();
  assert(response.ok(), `Web session was not accepted: ${response.status()} ${text}`);
  const me = JSON.parse(text);
  assert(
    me.email === state.oidcUser.email,
    `Unexpected Web session email ${me.email}`,
  );
  assert(
    me.id === process.env.FEDERATION_E2E_ADMIN_USER_ID,
    `Final UI E2E identity is not the configured platform admin (${me.id})`,
  );
}

async function ensureTenantOwnerMembership() {
  const identity = await prisma.userIdentity.findFirst({
    where: {
      email: state.oidcUser.email,
      identityProviderId: state.oidcProviderId,
    },
  });
  assert(identity, "Final UI login did not create the expected UserIdentity");

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
}

async function openTenantDashboard(page) {
  const deepLink = `${webOrigin}/tenants/${encodeURIComponent(state.tenantId)}/overview`;
  const response = await page.context().request.get(deepLink);
  assert(
    response.status() === 200,
    `Tenant overview deep-link returned ${response.status()}`,
  );

  await page.goto(deepLink, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Tenant Overview", level: 1 })
    .waitFor();

  const summary = page.getByRole("region", { name: "Tenant summary" });
  await summary.waitFor();
  for (const label of ["Applications", "Running workloads", "Storage usage", "Current balance"]) {
    await summary.getByText(label, { exact: true }).waitFor();
  }

  await page.goto(
    `${webOrigin}/tenants/${encodeURIComponent(state.tenantId)}/applications`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Applications", level: 1 }).waitFor();
  await page.getByRole("link", { name: "Create App Group" }).first().waitFor();
}

async function createAppGroup(page, appGroupName) {
  await page.getByRole("link", { name: "Create App Group" }).first().click();
  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/applications/new$`),
  );
  await page.getByRole("heading", { name: "Create App Group", level: 1 }).waitFor();

  await page.getByLabel("Name", { exact: false }).fill(appGroupName);
  await page
    .getByLabel("Description", { exact: false })
    .fill("ResourcePortal v0.1.9 final UI browser E2E");
  await page
    .getByLabel("Initial runtime state", { exact: false })
    .selectOption("Stopped");

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("heading", { name: "Review + create" }).waitFor();
  await page.getByRole("button", { name: "Create App Group", exact: true }).click();
  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/app-groups/[0-9a-f-]+$`),
  );
  await page.getByRole("heading", { name: appGroupName, level: 1 }).waitFor();
  await page.getByRole("navigation", { name: "App Group sections" }).waitFor();
}

async function createApplication(page, appGroupId, applicationName) {
  const tabs = page.getByRole("navigation", { name: "App Group sections" });
  await tabs.getByRole("link", { name: "Apps", exact: true }).click();
  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/app-groups/${appGroupId}/apps$`),
  );
  await page.getByRole("heading", { name: "Apps", level: 2 }).waitFor();

  await page.getByRole("link", { name: "Create application" }).first().click();
  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/app-groups/${appGroupId}/apps/new$`),
  );
  await page.getByRole("heading", { name: "Create application", level: 2 }).waitFor();

  await page.getByLabel("Name", { exact: false }).fill(applicationName);
  await page
    .getByLabel("Container image", { exact: false })
    .fill("nginx:alpine");
  await page
    .getByLabel("Description", { exact: false })
    .fill("v0.1.9 final UI E2E application");

  await nextWizardStep(page, "Volumes");
  await nextWizardStep(page, "Config");
  await nextWizardStep(page, "Resources");
  await page
    .getByLabel("Desired runtime", { exact: false })
    .selectOption("Stopped");
  await nextWizardStep(page, "Review & create");

  await page.getByRole("button", { name: "Create application", exact: true }).click();
  await page.waitForURL(
    new RegExp(
      `/tenants/${state.tenantId}/app-groups/${appGroupId}/apps/[0-9a-f-]+$`,
    ),
  );
  await page.getByRole("heading", { name: applicationName, level: 2 }).waitFor();
}

async function nextWizardStep(page, expectedHeading) {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
}

async function verifyApplicationDetailAndEdit(page, applicationName) {
  await page.getByRole("link", { name: "Edit application" }).click();
  await page.waitForURL(/\/apps\/[0-9a-f-]+\/edit$/);
  await page.getByRole("heading", { name: "Edit application details", level: 3 }).waitFor();
  await page.getByLabel("Name", { exact: false }).waitFor();
  assert(
    (await page.getByLabel("Name", { exact: false }).inputValue()) ===
      applicationName,
    "Application edit screen did not load the created application",
  );
}

async function deleteAppGroupThroughFinalDialog(page, appGroupId, appGroupName) {
  await page.goto(
    `${webOrigin}/tenants/${encodeURIComponent(state.tenantId)}/app-groups/${encodeURIComponent(appGroupId)}/settings`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: appGroupName, level: 1 }).waitFor();
  await page.getByRole("heading", { name: "Settings & advanced", level: 2 }).waitFor();

  await page
    .getByRole("button", { name: "Delete App Group", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: `Delete App Group ${appGroupName}?` })
    .waitFor();
  await dialog
    .getByRole("button", { name: "Delete App Group", exact: true })
    .click();

  await page.waitForURL(
    new RegExp(`/tenants/${state.tenantId}/applications$`),
  );
  await page.getByRole("heading", { name: "Applications", level: 1 }).waitFor();
}

function appGroupIdFromUrl(url) {
  const match = new URL(url).pathname.match(/\/app-groups\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function routeToKeycloak(page, providerLabel) {
  const keycloak = new URL(keycloakOrigin);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = new URL(page.url());
    if (current.origin === keycloak.origin) return;

    const providerControl = page.getByText(providerLabel, { exact: false }).first();
    if (
      (await providerControl.count()) > 0 &&
      (await providerControl.isVisible().catch(() => false))
    ) {
      await providerControl.dispatchEvent("click");
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
    `Final UI login did not return to Resource Portal API; current URL: ${page.url()}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
