import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const webOrigin = (
  process.env.STAGE20_REAL_SWARM_WEB_ORIGIN ?? "http://127.0.0.1:4173"
).replace(/\/$/, "");
const userId = process.env.SMOKE_USER_ID;
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });

const expectedContracts = [
  ["GET", "/health"],
  ["GET", "/health/live"],
  ["GET", "/health/ready"],
  ["GET", "/auth/me"],
  ["GET", "/auth/providers"],
  ["GET", "/auth/login"],
  ["GET", "/auth/register"],
  ["GET", "/auth/recover"],
  ["POST", "/auth/logout"],
  ["GET", "/tenants"],
  ["POST", "/tenants"],
  ["GET", "/tenants/*"],
  ["GET", "/tenants/*/memberships"],
  ["POST", "/tenants/*/memberships"],
  ["PATCH", "/tenants/*/memberships/*"],
  ["DELETE", "/tenants/*/memberships/*"],
  ["GET", "/tenants/*/roles"],
  ["GET", "/tenants/*/invitations"],
  ["POST", "/tenants/*/invitations"],
  ["POST", "/tenants/*/invitations/*/resend"],
  ["DELETE", "/tenants/*/invitations/*"],
  ["GET", "/tenants/*/groups"],
  ["POST", "/tenants/*/groups"],
  ["PATCH", "/tenants/*/groups/*"],
  ["DELETE", "/tenants/*/groups/*"],
  ["GET", "/tenants/*/auth-policy"],
  ["PATCH", "/tenants/*/auth-policy"],
  ["GET", "/tenants/*/identity-providers"],
  ["POST", "/tenants/*/identity-providers"],
  ["PATCH", "/tenants/*/identity-providers/*"],
  ["DELETE", "/tenants/*/identity-providers/*"],
  ["GET", "/tenants/*/oauth-applications"],
  ["POST", "/tenants/*/oauth-applications"],
  ["PATCH", "/tenants/*/oauth-applications/*"],
  ["DELETE", "/tenants/*/oauth-applications/*"],
  ["POST", "/tenants/*/oauth-applications/*/rotate-credentials"],
  ["GET", "/tenants/*/service-identities"],
  ["POST", "/tenants/*/service-identities"],
  ["PATCH", "/tenants/*/service-identities/*"],
  ["DELETE", "/tenants/*/service-identities/*"],
  ["POST", "/tenants/*/service-identities/*/rotate-credentials"],
  ["GET", "/tenants/*/billing"],
  ["GET", "/tenants/*/billing/transactions"],
  ["GET", "/tenants/*/billing/usage-records"],
  ["POST", "/tenants/*/billing/top-up"],
  ["GET", "/tenants/*/quota"],
  ["PATCH", "/tenants/*/quota"],
  ["GET", "/tenants/*/audit-log"],
  ["GET", "/tenants/*/audit-log/export"],
  ["GET", "/tenants/*/operations"],
  ["GET", "/tenants/*/operations/*"],
  ["GET", "/tenants/*/operations/*/events"],
  ["POST", "/tenants/*/operations/*/retry"],
  ["GET", "/tenants/*/app-groups"],
  ["POST", "/tenants/*/app-groups"],
  ["GET", "/tenants/*/app-groups/*"],
  ["PATCH", "/tenants/*/app-groups/*"],
  ["DELETE", "/tenants/*/app-groups/*"],
  ["POST", "/tenants/*/app-groups/*/runtime/start"],
  ["POST", "/tenants/*/app-groups/*/runtime/stop"],
  ["POST", "/tenants/*/app-groups/*/runtime/restart"],
  ["POST", "/tenants/*/app-groups/*/discard-changes"],
  ["GET", "/tenants/*/app-groups/*/stack-preview"],
  ["GET", "/tenants/*/app-groups/*/single-apps"],
  ["POST", "/tenants/*/app-groups/*/single-apps"],
  ["PATCH", "/tenants/*/app-groups/*/single-apps/*"],
  ["DELETE", "/tenants/*/app-groups/*/single-apps/*"],
  ["POST", "/tenants/*/app-groups/*/single-apps/*/runtime/start"],
  ["POST", "/tenants/*/app-groups/*/single-apps/*/runtime/stop"],
  ["POST", "/tenants/*/app-groups/*/single-apps/*/runtime/restart"],
  ["GET", "/tenants/*/app-groups/*/single-apps/*/runtime-config"],
  ["PATCH", "/tenants/*/app-groups/*/single-apps/*/runtime-config"],
  ["GET", "/tenants/*/app-groups/*/single-apps/*/http-endpoints"],
  ["POST", "/tenants/*/app-groups/*/single-apps/*/http-endpoints"],
  ["PATCH", "/tenants/*/app-groups/*/single-apps/*/http-endpoints/*"],
  ["DELETE", "/tenants/*/app-groups/*/single-apps/*/http-endpoints/*"],
  ["GET", "/tenants/*/app-groups/*/variables"],
  ["POST", "/tenants/*/app-groups/*/variables"],
  ["PATCH", "/tenants/*/app-groups/*/variables/*"],
  ["DELETE", "/tenants/*/app-groups/*/variables/*"],
  ["GET", "/tenants/*/app-groups/*/configs"],
  ["POST", "/tenants/*/app-groups/*/configs"],
  ["PATCH", "/tenants/*/app-groups/*/configs/*"],
  ["DELETE", "/tenants/*/app-groups/*/configs/*"],
  ["GET", "/tenants/*/app-groups/*/secrets"],
  ["POST", "/tenants/*/app-groups/*/secrets"],
  ["PATCH", "/tenants/*/app-groups/*/secrets/*"],
  ["DELETE", "/tenants/*/app-groups/*/secrets/*"],
  ...["variable", "config", "secret", "volume"].flatMap((type) => [
    ["POST", `/tenants/*/app-groups/*/single-apps/*/${type}-attachments`],
    ["DELETE", `/tenants/*/app-groups/*/single-apps/*/${type}-attachments/*`],
  ]),
  ["POST", "/tenants/*/app-groups/*/deploy"],
  ["GET", "/tenants/*/app-groups/*/deployments"],
  ["GET", "/tenants/*/app-groups/*/deployments/*"],
  ["GET", "/tenants/*/app-groups/*/deployments/*/events"],
  ["POST", "/tenants/*/app-groups/*/deployments/*/rollback"],
  ["GET", "/tenants/*/volumes"],
  ["POST", "/tenants/*/volumes"],
  ["DELETE", "/tenants/*/volumes/*"],
  ["PATCH", "/tenants/*/volumes/*/resize"],
  ["GET", "/tenants/*/registries"],
  ["POST", "/tenants/*/registries"],
  ["PATCH", "/tenants/*/registries/*"],
  ["DELETE", "/tenants/*/registries/*"],
  ["POST", "/tenants/*/registries/*/validate"],
  ["GET", "/tenants/*/domains"],
  ["POST", "/tenants/*/domains"],
  ["PATCH", "/tenants/*/domains/*"],
  ["DELETE", "/tenants/*/domains/*"],
  ["POST", "/tenants/*/domains/*/validate"],
  ["GET", "/tenants/*/domains/custom-root-domains"],
  ["POST", "/tenants/*/domains/custom-root-domains"],
  ["PATCH", "/tenants/*/domains/custom-root-domains/*"],
  ["DELETE", "/tenants/*/domains/custom-root-domains/*"],
  ["POST", "/tenants/*/domains/custom-root-domains/*/validate"],
  ["GET", "/platform/maintenance"],
  ["PATCH", "/platform/maintenance"],
  ["GET", "/platform/swarm-cluster"],
  ["POST", "/platform/swarm-cluster/reconcile"],
  ["GET", "/platform/remote-locations"],
  ["PATCH", "/platform/remote-locations/*/maintenance"],
  ["GET", "/platform/storage-backends"],
  ["POST", "/platform/storage-backends/*/validate"],
  ["PATCH", "/platform/storage-backends/*/maintenance"],
  ["GET", "/platform/identity-providers"],
  ["POST", "/platform/identity-providers"],
  ["PATCH", "/platform/identity-providers/*"],
  ["DELETE", "/platform/identity-providers/*"],
  ["GET", "/platform/oauth-applications"],
  ["POST", "/platform/oauth-applications"],
  ["PATCH", "/platform/oauth-applications/*"],
  ["DELETE", "/platform/oauth-applications/*"],
  ["POST", "/platform/oauth-applications/*/rotate-credentials"],
  ["GET", "/platform/service-identities"],
  ["POST", "/platform/service-identities"],
  ["PATCH", "/platform/service-identities/*"],
  ["DELETE", "/platform/service-identities/*"],
  ["POST", "/platform/service-identities/*/rotate-credentials"],
  ["GET", "/platform/billing/price-lists"],
  ["POST", "/platform/billing/price-lists"],
  ["GET", "/platform/billing/vouchers"],
  ["POST", "/platform/billing/vouchers"],
  ["POST", "/platform/billing/vouchers/*/disable"],
  ["POST", "/platform/billing/payments"],
  ["POST", "/platform/billing/refunds"],
  ["POST", "/platform/billing/corrections"],
];

const tenantRoutes = [
  ["overview", "Tenant overview"],
  ["app-groups", "AppGroups"],
  ["volumes", "Volumes"],
  ["registries", "Registries"],
  ["domains", "Domains and HTTP routing"],
  ["administration", "Tenant administration"],
  ["credentials", "Tenant machine credentials"],
  ["billing", "Billing and quota"],
  ["audit", "Audit log"],
  ["operations", "Operations / jobs"],
];

const platformRoutes = [
  ["overview", "Platform overview"],
  ["maintenance", "Platform maintenance"],
  ["infrastructure", "Platform infrastructure"],
  ["identity-providers", "Platform identity providers"],
  ["credentials", "Platform machine credentials"],
  ["billing", "Platform billing administration"],
];

let tenantId;
try {
  assert(userId, "SMOKE_USER_ID is required for the Stage 20 management matrix");

  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("**/api/**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-dev-user-id": userId,
      },
    });
  });

  try {
    const stamp = Date.now();
    const tenant = await proxyApi(context, "/tenants", {
      method: "POST",
      body: {
        name: `stage20-matrix-${stamp}`,
        displayName: "Stage 20 Management Matrix",
        contactEmail: `stage20-matrix-${stamp}@example.local`,
      },
    });
    tenantId = stringField(tenant, "id");

    const openapi = await proxyApi(context, "/openapi.json");
    const availableContracts = openApiContracts(openapi);
    const missing = expectedContracts.filter(
      ([method, path]) => !availableContracts.has(`${method} ${path}`),
    );
    assert(
      missing.length === 0,
      `Stage 20 Web/API contract is missing ${missing.length} operation(s):\n${missing
        .map(([method, path]) => `- ${method} ${path}`)
        .join("\n")}`,
    );

    await visit(page, "/health", "Resource Portal status", false);
    for (const [section, heading] of tenantRoutes) {
      await visit(
        page,
        `/tenants/${encodeURIComponent(tenantId)}/${section}`,
        heading,
      );
    }
    for (const [section, heading] of platformRoutes) {
      await visit(page, `/platform/${section}`, heading);
    }

    console.log(
      `Stage 20 management matrix passed: ${expectedContracts.length} API contracts and ${tenantRoutes.length + platformRoutes.length + 1} document routes`,
    );
  } finally {
    await context.close();
  }
} finally {
  if (tenantId) {
    await prisma.tenant
      .delete({ where: { id: tenantId } })
      .catch((error) =>
        console.warn(`Stage 20 matrix tenant cleanup failed: ${error.message}`),
      );
  }
  await browser.close();
  await prisma.$disconnect();
}

async function visit(page, path, heading, authenticated = true) {
  await page.goto(`${webOrigin}${path}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
  await page.waitForFunction(() => {
    const loading = [...document.querySelectorAll("p")].some((element) =>
      ["Loading…", "Loading tenants…"].includes(element.textContent?.trim() ?? ""),
    );
    return !loading;
  });
  if (authenticated) {
    assert(
      (await page.getByRole("alert").count()) === 0,
      `${path} rendered an API error alert`,
    );
  }
}

async function proxyApi(context, path, options = {}) {
  const response = await context.request.fetch(`${webOrigin}/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      "x-dev-user-id": userId,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    data: options.body,
  });
  const text = await response.text();
  assert(
    response.ok(),
    `${options.method ?? "GET"} ${path} failed: ${response.status()} ${text}`,
  );
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function openApiContracts(document) {
  assert(document && typeof document === "object", "OpenAPI response is not an object");
  const paths = document.paths;
  assert(paths && typeof paths === "object", "OpenAPI response has no paths object");
  const result = new Set();
  for (const [rawPath, operations] of Object.entries(paths)) {
    if (!operations || typeof operations !== "object") continue;
    const normalizedPath = normalizePath(rawPath);
    for (const method of Object.keys(operations)) {
      const upper = method.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(upper)) {
        result.add(`${upper} ${normalizedPath}`);
      }
    }
  }
  return result;
}

function normalizePath(path) {
  const withoutApi = path.startsWith("/api/") ? path.slice(4) : path === "/api" ? "/" : path;
  return withoutApi.replace(/\{[^/]+\}/g, "*");
}

function stringField(value, field) {
  assert(value && typeof value === "object", `Expected object with ${field}`);
  const fieldValue = value[field];
  assert(
    typeof fieldValue === "string" && fieldValue.length > 0,
    `Expected non-empty string field ${field}`,
  );
  return fieldValue;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
