import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const webOrigin = (
  process.env.STAGE20_REAL_SWARM_WEB_ORIGIN ?? "http://127.0.0.1:4173"
).replace(/\/$/, "");
const userId = process.env.SMOKE_USER_ID;
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });

let createdTenantId;
let createdStackName;

try {
  assert(userId, "SMOKE_USER_ID is required for the real-Swarm browser smoke");
  await preflightSwarm();

  const context = await browser.newContext();
  const page = await context.newPage();
  const stamp = Date.now();
  const tenantName = `web-swarm-${stamp}`;
  const appGroupName = `web-swarm-appgroup-${stamp}`;
  const singleAppName = "nginx";

  await context.route("**/api/**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-dev-user-id": userId,
      },
    });
  });

  try {
    await page.goto(`${webOrigin}/tenants`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Choose a tenant", level: 1 })
      .waitFor();

    const tenant = await proxyApi(context, "/tenants", {
      method: "POST",
      body: {
        name: tenantName,
        displayName: "Stage 20 Real Swarm",
        contactEmail: `${tenantName}@example.local`,
      },
    });
    createdTenantId = stringField(tenant, "id");

    await proxyApi(context, `/tenants/${createdTenantId}/quota`, {
      method: "PATCH",
      body: {
        cpu: 2,
        memoryBytes: 536870912,
        gpu: 0,
        storageBytes: 1073741824,
        maxSingleApps: 5,
        maxVolumes: 5,
      },
    });
    await proxyApi(context, "/platform/billing/corrections", {
      method: "POST",
      body: {
        tenantId: createdTenantId,
        amountCredits: "100",
        reason: "Stage 20 real Swarm browser fixture",
      },
    });

    await page.goto(
      `${webOrigin}/tenants/${encodeURIComponent(createdTenantId)}/applications`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByRole("heading", { name: "Applications", level: 1 })
      .waitFor();
    await page
      .getByRole("link", { name: "Create App Group" })
      .first()
      .click();
    await page.waitForURL(
      new RegExp(`/tenants/${createdTenantId}/applications/new$`),
    );
    await page
      .getByRole("heading", { name: "Create App Group", level: 1 })
      .waitFor();
    await page.getByLabel("Name", { exact: false }).fill(appGroupName);
    await page
      .getByLabel("Description", { exact: false })
      .fill("Real Docker Swarm browser smoke for ResourcePortal v0.1.9");
    await page
      .getByLabel("Initial runtime state", { exact: false })
      .selectOption("Running");
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page
      .getByRole("heading", { name: "Review + create", level: 2 })
      .waitFor();

    const createGroupResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups`,
    );
    await page
      .getByRole("button", { name: "Create App Group", exact: true })
      .click();
    const groupResponse = await createGroupResponse;
    assert(
      groupResponse.ok(),
      `Web App Group create failed: ${groupResponse.status()}`,
    );
    await page.waitForURL(
      new RegExp(`/tenants/${createdTenantId}/app-groups/[0-9a-f-]+$`),
    );
    const appGroupId = resourceIdFromUrl(page.url(), "app-groups");
    assert(appGroupId, `App Group route did not expose an id: ${page.url()}`);
    createdStackName = stackNameFor(appGroupId);
    await page
      .getByRole("heading", { name: appGroupName, level: 1 })
      .waitFor();

    const tabs = page.getByRole("navigation", { name: "App Group sections" });
    await tabs.getByRole("link", { name: "Apps", exact: true }).click();
    await page.waitForURL(
      new RegExp(
        `/tenants/${createdTenantId}/app-groups/${appGroupId}/apps$`,
      ),
    );
    await page.getByRole("heading", { name: "Apps", level: 2 }).waitFor();
    await page
      .getByRole("link", { name: "Create application" })
      .first()
      .click();
    await page.waitForURL(
      new RegExp(
        `/tenants/${createdTenantId}/app-groups/${appGroupId}/apps/new$`,
      ),
    );

    await page.getByLabel("Name", { exact: false }).fill(singleAppName);
    await page
      .getByLabel("Container image", { exact: false })
      .fill("nginx:alpine");
    await page
      .getByLabel("Description", { exact: false })
      .fill("ResourcePortal v0.1.9 real Swarm browser workload");
    await nextWizardStep(page, "Volumes");
    await nextWizardStep(page, "Config");
    await nextWizardStep(page, "Resources");
    await page
      .getByLabel("Desired runtime", { exact: false })
      .selectOption("Running");
    await nextWizardStep(page, "Review & create");

    const createAppResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups/${appGroupId}/single-apps`,
    );
    await page
      .getByRole("button", { name: "Create application", exact: true })
      .click();
    const appResponse = await createAppResponse;
    assert(
      appResponse.ok(),
      `Web application create failed: ${appResponse.status()}`,
    );
    await page.waitForURL(
      new RegExp(
        `/tenants/${createdTenantId}/app-groups/${appGroupId}/apps/[0-9a-f-]+$`,
      ),
    );
    const singleAppId = resourceIdFromUrl(page.url(), "apps");
    assert(singleAppId, `Application route did not expose an id: ${page.url()}`);
    await page
      .getByRole("heading", { name: singleAppName, level: 2 })
      .waitFor();

    await page.goto(
      `${webOrigin}/tenants/${createdTenantId}/app-groups/${appGroupId}/deployments`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByRole("heading", { name: "Deployments", level: 2 })
      .waitFor();
    await page
      .getByLabel("Deployment note", { exact: false })
      .fill("Stage 20 real Swarm browser deploy");

    const deployResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups/${appGroupId}/deploy`,
    );
    await page
      .getByRole("button", { name: "Deploy pending changes", exact: true })
      .click();
    const deployResponse = await deployResponsePromise;
    const deployText = await deployResponse.text();
    assert(
      deployResponse.ok(),
      `Web deploy failed: ${deployResponse.status()} ${deployText}`,
    );
    const deployment = JSON.parse(deployText);
    const deploymentId = stringField(deployment, "id");
    const deploymentVersion = Number(deployment.version);
    assert(
      Number.isInteger(deploymentVersion),
      `Deployment ${deploymentId} did not expose an integer version`,
    );

    await runDeploymentWorkerOnce();
    await expectDeploymentStatus(
      context,
      createdTenantId,
      appGroupId,
      deploymentId,
      "Succeeded",
    );
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    await page.reload({ waitUntil: "domcontentloaded" });
    const deploymentRow = page
      .getByRole("row")
      .filter({ hasText: `v${deploymentVersion}` });
    await deploymentRow.waitFor();
    assert(
      (await deploymentRow.textContent())?.includes("Succeeded"),
      "Deployment history did not show the browser-created deployment as Succeeded",
    );

    const appUrl =
      `${webOrigin}/tenants/${createdTenantId}/app-groups/${appGroupId}/apps/${singleAppId}`;
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: singleAppName, level: 2 })
      .waitFor();

    await page
      .getByRole("button", { name: "Stop application", exact: true })
      .click();
    await waitForReplicas(createdStackName, singleAppName, "0/0");

    await page
      .getByRole("button", { name: "Start application", exact: true })
      .click();
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    const serviceName = `${createdStackName}_${singleAppName}`;
    const forceUpdateBefore = await serviceForceUpdate(serviceName);
    await page
      .getByRole("button", { name: "Restart application", exact: true })
      .click();
    await waitForForceUpdate(serviceName, forceUpdateBefore + 1);
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    await page.goto(
      `${webOrigin}/tenants/${createdTenantId}/app-groups/${appGroupId}/deployments`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByRole("heading", { name: "Deployments", level: 2 })
      .waitFor();
    const rollbackSourceRow = page
      .getByRole("row")
      .filter({ hasText: `v${deploymentVersion}` });
    await rollbackSourceRow.waitFor();
    await rollbackSourceRow
      .getByRole("button", { name: "Rollback", exact: true })
      .click();

    const rollbackResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups/${appGroupId}/deployments/${deploymentId}/rollback`,
    );
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog
      .getByRole("button", { name: /^Rollback to v/ })
      .click();
    const rollbackResponse = await rollbackResponsePromise;
    const rollbackText = await rollbackResponse.text();
    assert(
      rollbackResponse.ok(),
      `Web rollback failed: ${rollbackResponse.status()} ${rollbackText}`,
    );
    const rollback = JSON.parse(rollbackText);
    const rollbackDeploymentId = stringField(rollback, "id");

    await runDeploymentWorkerOnce();
    await expectDeploymentStatus(
      context,
      createdTenantId,
      appGroupId,
      rollbackDeploymentId,
      "Succeeded",
    );
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Deployments", level: 2 })
      .waitFor();
    const succeededRows = page
      .getByRole("row")
      .filter({ hasText: "Succeeded" });
    await succeededRows.nth(1).waitFor();
    assert(
      (await succeededRows.count()) >= 2,
      "Deployment history did not show both the deployment and rollback as Succeeded",
    );

    console.log(
      `ResourcePortal v0.1.9 Web Console real Swarm browser E2E passed for tenant ${createdTenantId}`,
    );
  } catch (error) {
    const snapshot = await page.content().catch(() => "<page unavailable>");
    console.error(`v0.1.9 real Swarm browser E2E failed at ${page.url()}`);
    console.error(snapshot.slice(0, 8_000));
    throw error;
  } finally {
    await context.close();
  }
} finally {
  if (createdStackName) {
    await docker(["stack", "rm", createdStackName], true);
    await waitForStackRemoval(createdStackName);
  }
  if (createdTenantId) {
    await prisma.tenant
      .delete({ where: { id: createdTenantId } })
      .catch((error) =>
        console.warn(
          `v0.1.9 real Swarm fixture tenant cleanup failed: ${error.message}`,
        ),
      );
  }
  await browser.close();
  await prisma.$disconnect();
}

async function nextWizardStep(page, expectedHeading) {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("heading", { name: expectedHeading, exact: true })
    .waitFor();
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

async function expectDeploymentStatus(
  context,
  tenantId,
  appGroupId,
  deploymentId,
  expected,
) {
  const deployment = await proxyApi(
    context,
    `/tenants/${tenantId}/app-groups/${appGroupId}/deployments/${deploymentId}`,
  );
  const status = stringField(deployment, "status");
  assert(
    status === expected,
    `Expected deployment ${deploymentId} status ${expected}, got ${status}`,
  );
}

async function preflightSwarm() {
  const result = await docker([
    "info",
    "--format",
    "{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}",
  ]);
  assert(
    result.stdout.trim() === "active true",
    `Docker context ${dockerContext} is not a Swarm manager (${result.stdout.trim() || "empty docker info"})`,
  );
}

async function runDeploymentWorkerOnce() {
  const result = await command(
    "npm",
    ["--workspace", "@resource-portal/api", "run", "worker"],
    {
      ...process.env,
      WORKER_ONCE: "true",
    },
  );
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (output) console.log(output);
  assert(result.exitCode === 0, output || "ResourcePortal worker failed");
}

async function waitForReplicas(stackName, singleAppName, expected) {
  const serviceName = `${stackName}_${singleAppName}`;
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await docker(
      [
        "service",
        "ls",
        "--filter",
        `name=${serviceName}`,
        "--format",
        "{{.Name}} {{.Replicas}}",
      ],
      true,
    );
    const row = result.stdout
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${serviceName} `));
    last = row?.slice(serviceName.length + 1).trim() ?? "missing";
    if (last === expected) return;
    await sleep(2_000);
  }
  throw new Error(
    `Expected ${serviceName} replicas ${expected}, got ${last}`,
  );
}

async function serviceForceUpdate(serviceName) {
  const result = await docker([
    "service",
    "inspect",
    serviceName,
    "--format",
    "{{.Spec.TaskTemplate.ForceUpdate}}",
  ]);
  const value = Number.parseInt(result.stdout.trim(), 10);
  assert(Number.isInteger(value), `Invalid ForceUpdate for ${serviceName}`);
  return value;
}

async function waitForForceUpdate(serviceName, expectedMinimum) {
  let last = -1;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await docker(
      [
        "service",
        "inspect",
        serviceName,
        "--format",
        "{{.Spec.TaskTemplate.ForceUpdate}}",
      ],
      true,
    );
    last = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(last) && last >= expectedMinimum) return;
    await sleep(1_000);
  }
  throw new Error(
    `Expected ${serviceName} ForceUpdate >= ${expectedMinimum}, got ${last}`,
  );
}

async function waitForStackRemoval(stackName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await docker(
      ["stack", "ls", "--format", "{{.Name}}"],
      true,
    );
    if (!result.stdout.split("\n").includes(stackName)) return;
    await sleep(1_000);
  }
  throw new Error(`Stack ${stackName} was not removed during cleanup`);
}

function resourceIdFromUrl(url, segment) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf(segment);
  return index >= 0 ? parts[index + 1] : undefined;
}

function stackNameFor(appGroupId) {
  return `rp_${appGroupId.replaceAll("-", "_")}`;
}

async function docker(args, ignoreFailure = false) {
  const result = await command("docker", ["--context", dockerContext, ...args]);
  if (result.exitCode !== 0 && !ignoreFailure) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function command(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}