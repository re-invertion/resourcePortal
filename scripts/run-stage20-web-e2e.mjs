import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const statePath = resolve(process.env.FEDERATION_E2E_STATE_FILE ?? "var/federation/state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const apiOrigin = process.env.FEDERATION_E2E_RP_ORIGIN ?? "http://localhost:3000";
const webOrigin = process.env.FEDERATION_E2E_WEB_ORIGIN ?? "http://localhost:4173";
const keycloakOrigin = process.env.FEDERATION_E2E_KEYCLOAK_ORIGIN ?? "http://localhost:8180";
const zitadelOrigin = process.env.FEDERATION_E2E_ZITADEL_ORIGIN ?? "http://localhost:8080";
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const appGroupName = `web-e2e-${Date.now()}`;

  try {
    await page.goto(`${webOrigin}/login?tenantId=${encodeURIComponent(state.tenantId)}`, {
      waitUntil: "domcontentloaded",
    });
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
    assert(meResponse.ok(), `Web proxy did not accept the RP session: ${meResponse.status()} ${meText}`);
    const me = JSON.parse(meText);
    assert(me.email === state.oidcUser.email, `Unexpected Web session email ${me.email}`);

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
    assert(deepLinkResponse.status() === 200, `Tenant deep-link returned ${deepLinkResponse.status()}`);
    assert(
      deepLinkHtml.includes('data-route-kind="tenant"') &&
        deepLinkHtml.includes(`data-tenant-id="${state.tenantId}"`),
      "Tenant deep-link was not server-rendered with tenant route metadata",
    );

    await page.goto(deepLink, { waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "Tenant overview" }).waitFor();
    assert((await page.getByRole("alert").count()) === 0, "Tenant overview rendered an error alert");

    const primary = page.getByRole("navigation", { name: "Primary" });
    await primary.getByRole("link", { name: "app-groups", exact: true }).click();
    await page.waitForURL(new RegExp(`/tenants/${state.tenantId}/app-groups$`));
    await page.locator("main > h1", { hasText: "AppGroups" }).waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "AppGroups" }).waitFor();

    const appGroupsSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "AppGroups", level: 2 }) })
      .first();
    await appGroupsSection.locator("summary", { hasText: "Create" }).click();
    await appGroupsSection.getByRole("textbox", { name: "JSON payload" }).fill(
      JSON.stringify({ name: appGroupName }, null, 2),
    );
    await appGroupsSection.getByRole("button", { name: "Create", exact: true }).click();

    const createdRow = page.getByRole("row").filter({ hasText: appGroupName });
    await createdRow.waitFor();
    await createdRow.getByRole("link", { name: "Open" }).click();
    await page.waitForURL(new RegExp(`/tenants/${state.tenantId}/app-groups/[0-9a-f-]+$`));
    await page.locator("main > h1", { hasText: "AppGroup" }).waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main > h1", { hasText: "AppGroup" }).waitFor();

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "app-groups", exact: true })
      .click();
    await page.locator("main > h1", { hasText: "AppGroups" }).waitFor();

    const cleanupRow = page.getByRole("row").filter({ hasText: appGroupName });
    await cleanupRow.waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await cleanupRow.getByRole("button", { name: "Delete" }).click();
    await cleanupRow.waitFor({ state: "detached" });

    const storageKeys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    assert(
      storageKeys.every((key) => !/(token|session|secret|credential)/i.test(key)),
      `Web Console persisted auth-like browser storage keys: ${storageKeys.join(", ")}`,
    );

    console.log(`Stage 20 Web Console browser E2E passed for tenant ${state.tenantId}`);
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

async function routeToKeycloak(page, providerLabel) {
  const keycloak = new URL(keycloakOrigin);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = new URL(page.url());
    if (current.origin === keycloak.origin) return;

    const providerControl = page.getByText(providerLabel, { exact: false }).first();
    if ((await providerControl.count()) > 0 && (await providerControl.isVisible().catch(() => false))) {
      await providerControl.click();
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`ZITADEL did not redirect to tenant provider; current URL: ${page.url()}`);
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
      if ((await skipMfa.count()) > 0 && (await skipMfa.isVisible().catch(() => false))) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          skipMfa.click(),
        ]);
        continue;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Web login did not return to Resource Portal API; current URL: ${page.url()}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
