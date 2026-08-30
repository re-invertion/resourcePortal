import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const statePath = resolve(process.env.FEDERATION_E2E_STATE_FILE ?? "var/federation/state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const apiOrigin = process.env.FEDERATION_E2E_RP_ORIGIN ?? "http://localhost:3000";
const keycloakOrigin = process.env.FEDERATION_E2E_KEYCLOAK_ORIGIN ?? "http://localhost:8180";
const zitadelOrigin = process.env.FEDERATION_E2E_ZITADEL_ORIGIN ?? "http://localhost:8080";
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });

try {
  await loginThroughTenantProvider({
    protocol: "OIDC",
    providerId: state.oidcProviderId,
    providerLabel: "Tenant Keycloak OIDC",
    tenantId: state.tenantId,
    user: state.oidcUser,
  });

  await loginThroughTenantProvider({
    protocol: "SAML",
    providerId: state.samlProviderId,
    providerLabel: "Tenant Keycloak SAML",
    tenantId: state.tenantId,
    user: state.samlUser,
  });

  console.log("Live tenant OIDC and SAML federation logins succeeded");
} finally {
  await browser.close();
  await prisma.$disconnect();
}

async function loginThroughTenantProvider({
  protocol,
  providerId,
  providerLabel,
  tenantId,
  user,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginUrl = `${apiOrigin}/api/auth/login?tenantId=${encodeURIComponent(tenantId)}&identityProviderId=${encodeURIComponent(providerId)}`;

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await routeToKeycloak(page, providerLabel);

    await page.locator("#username").fill(user.username);
    await page.locator("#password").fill(user.password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator("#kc-login").click(),
    ]);

    await finishZitadelLogin(page, protocol);

    const meResponse = await context.request.get(`${apiOrigin}/api/auth/me`);
    const meText = await meResponse.text();
    assert(meResponse.ok(), `${protocol} RP session was not accepted: ${meResponse.status()} ${meText}`);
    const me = JSON.parse(meText);
    assert(
      me.email === user.email,
      `${protocol} login returned unexpected email ${me.email}; expected ${user.email}`,
    );

    const identity = await prisma.userIdentity.findFirst({
      where: {
        email: user.email,
        identityProviderId: providerId,
      },
      include: {
        user: true,
      },
    });
    assert(identity, `${protocol} login did not bind UserIdentity to the selected tenant provider`);
    assert(identity.user.status === "Active", `${protocol} federated user is not Active`);

    const activeSession = await prisma.portalSession.findFirst({
      where: {
        userId: identity.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    assert(activeSession, `${protocol} login did not create an active PortalSession`);

    console.log(`${protocol} federated login OK: ${user.email}`);
  } catch (error) {
    const snapshot = await page.content().catch(() => "<page unavailable>");
    console.error(`${protocol} login failed at ${page.url()}`);
    console.error(snapshot.slice(0, 8_000));
    throw error;
  } finally {
    await context.close();
  }
}

async function routeToKeycloak(page, providerLabel) {
  const keycloak = new URL(keycloakOrigin);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = new URL(page.url());
    if (current.origin === keycloak.origin) {
      return;
    }

    const providerControl = page.getByText(providerLabel, { exact: false }).first();
    if ((await providerControl.count()) > 0 && (await providerControl.isVisible().catch(() => false))) {
      await providerControl.click();
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`ZITADEL did not redirect to tenant provider; current URL: ${page.url()}`);
}

async function finishZitadelLogin(page, protocol) {
  const api = new URL(apiOrigin);
  const zitadel = new URL(zitadelOrigin);
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === api.origin) {
      return;
    }

    if (current.origin === zitadel.origin) {
      // A newly auto-created federated ZITADEL user can be offered optional
      // second-factor enrollment before the OIDC authorization completes.
      // The legacy login handler explicitly supports skip=true and records
      // HumanSkipMFAInit, so exercise the real onboarding path instead of
      // treating this optional screen as a federation failure.
      const skipMfa = page.locator(
        'form[action="/ui/login/mfa/prompt"] button[name="skip"][value="true"]',
      );
      if ((await skipMfa.count()) > 0 && (await skipMfa.isVisible().catch(() => false))) {
        console.log(`${protocol} skipping optional ZITADEL MFA enrollment`);
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          skipMfa.click(),
        ]);
        continue;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`${protocol} login did not return to Resource Portal; current URL: ${page.url()}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
