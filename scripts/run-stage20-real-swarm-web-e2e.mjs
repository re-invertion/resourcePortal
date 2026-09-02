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
    await page.getByRole("heading", { name: "Choose tenant" }).waitFor();
    assert(
      (await page.getByRole("alert").count()) === 0,
      "Tenant selector rendered an API error before the real-Swarm fixture was created",
    );

    const createTenantResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${webOrigin}/api/tenants`,
    );
    await fillStructuredForm(page, {
      name: tenantName,
      displayName: "Stage 20 Real Swarm",
      contactEmail: `${tenantName}@example.local`,
    });
    await page.getByRole("button", { name: "Create tenant" }).click();
    const tenantResponse = await createTenantResponse;
    const tenantText = await tenantResponse.text();
    assert(
      tenantResponse.ok(),
      `Web tenant create failed: ${tenantResponse.status()} ${tenantText}`,
    );
    const tenant = JSON.parse(tenantText);
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
    await proxyApi(context, `/tenants/${createdTenantId}/billing/top-up`, {
      method: "POST",
      body: {
        amount: 100,
        reference: "Stage 20 real Swarm browser fixture",
      },
    });

    await page.goto(
      `${webOrigin}/tenants/${encodeURIComponent(createdTenantId)}/app-groups`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("main > h1", { hasText: "AppGroups" }).waitFor();
    await waitForPageRequests(page, "app-groups");

    const appGroupsPanel = panelByHeading(page, "AppGroups");
    await createResource(appGroupsPanel, {
      name: appGroupName,
      runtimeState: "Running",
    });

    const appGroupRow = page.getByRole("row").filter({ hasText: appGroupName });
    await appGroupRow.waitFor();
    const appGroupId = (await appGroupRow.locator("td").first().textContent())?.trim();
    assert(appGroupId, "AppGroup create did not expose an id in the resource table");
    createdStackName = stackNameFor(appGroupId);

    await appGroupRow.getByRole("link", { name: "Open" }).click();
    await page.waitForURL(
      new RegExp(`/tenants/${createdTenantId}/app-groups/${appGroupId}$`),
    );
    await page.locator("main > h1", { hasText: "AppGroup" }).waitFor();
    await waitForPageRequests(page, "app-group-detail");

    const singleAppsPanel = panelByHeading(page, "SingleApps");
    await createResource(singleAppsPanel, {
      name: singleAppName,
      image: "nginx:alpine",
      desiredReplicas: 1,
      runtimeState: "Running",
      cpu: 0.1,
      memoryBytes: 134217728,
      environment: {
        STAGE20_REAL_SWARM: "true",
      },
    });

    let singleAppRow = page.getByRole("row").filter({ hasText: singleAppName });
    await singleAppRow.waitFor();
    const singleAppId = (await singleAppRow.locator("td").first().textContent())?.trim();
    assert(singleAppId, "SingleApp create did not expose an id in the resource table");

    const deploymentsSection = page
      .getByRole("heading", { name: "Deployments", level: 2 })
      .locator("xpath=parent::section");
    const deployResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups/${appGroupId}/deploy`,
    );
    await fillStructuredForm(deploymentsSection, {
      note: "Stage 20 real Swarm browser deploy",
    });
    await deploymentsSection.getByRole("button", { name: "Deploy" }).click();
    const deployResponse = await deployResponsePromise;
    const deployText = await deployResponse.text();
    assert(
      deployResponse.ok(),
      `Web deploy failed: ${deployResponse.status()} ${deployText}`,
    );
    const deployment = JSON.parse(deployText);
    const deploymentId = stringField(deployment, "id");

    await runDeploymentWorkerOnce();
    await expectDeploymentStatus(
      context,
      createdTenantId,
      appGroupId,
      deploymentId,
      "Succeeded",
    );
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    const deploymentHistoryPanel = panelByHeading(page, "Deployment history");
    await deploymentHistoryPanel.getByRole("button", { name: "Refresh" }).click();
    const deploymentRow = deploymentHistoryPanel
      .getByRole("row")
      .filter({ hasText: deploymentId });
    await deploymentRow.waitFor();
    assert(
      (await deploymentRow.textContent())?.includes("Succeeded"),
      "Deployment history did not show the browser-created deployment as Succeeded",
    );

    singleAppRow = page.getByRole("row").filter({ hasText: singleAppName });
    await singleAppRow.getByRole("button", { name: "Stop", exact: true }).click();
    await waitForReplicas(createdStackName, singleAppName, "0/0");

    singleAppRow = page.getByRole("row").filter({ hasText: singleAppName });
    await singleAppRow.getByRole("button", { name: "Start", exact: true }).click();
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    const serviceName = `${createdStackName}_${singleAppName}`;
    const forceUpdateBefore = await serviceForceUpdate(serviceName);
    singleAppRow = page.getByRole("row").filter({ hasText: singleAppName });
    await singleAppRow.getByRole("button", { name: "Restart", exact: true }).click();
    await waitForForceUpdate(serviceName, forceUpdateBefore + 1);
    await waitForReplicas(createdStackName, singleAppName, "1/1");

    await deploymentHistoryPanel.getByRole("button", { name: "Refresh" }).click();
    const rollbackSourceRow = deploymentHistoryPanel
      .getByRole("row")
      .filter({ hasText: deploymentId });
    await rollbackSourceRow.waitFor();
    await rollbackSourceRow.locator("summary", { hasText: "Rollback" }).click();

    const rollbackResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() ===
          `${webOrigin}/api/tenants/${createdTenantId}/app-groups/${appGroupId}/deployments/${deploymentId}/rollback`,
    );
    await fillStructuredForm(rollbackSourceRow, {
      note: "Stage 20 real Swarm browser rollback",
    });
    await rollbackSourceRow.getByRole("button", { name: "Rollback" }).click();
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

    await deploymentHistoryPanel.getByRole("button", { name: "Refresh" }).click();
    const rollbackRow = deploymentHistoryPanel
      .getByRole("row")
      .filter({ hasText: rollbackDeploymentId });
    await rollbackRow.waitFor();
    assert(
      (await rollbackRow.textContent())?.includes("Succeeded"),
      "Deployment history did not show the browser-created rollback as Succeeded",
    );
    assert(
      (await page.getByRole("alert").count()) === 0,
      "Real-Swarm browser flow rendered an API error alert",
    );

    console.log(
      `Stage 20 Web Console real Swarm browser E2E passed for tenant ${createdTenantId}`,
    );
  } catch (error) {
    const snapshot = await page.content().catch(() => "<page unavailable>");
    console.error(`Stage 20 real Swarm browser E2E failed at ${page.url()}`);
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
          `Stage 20 real Swarm fixture tenant cleanup failed: ${error.message}`,
        ),
      );
  }
  await browser.close();
  await prisma.$disconnect();
}

function panelByHeading(page, heading) {
  const title = page.getByRole("heading", { name: heading, level: 2 });
  return title.locator(
    "xpath=parent::header/parent::section | parent::section/parent::section",
  );
}

async function createResource(panel, body) {
  await panel.locator("summary", { hasText: "Create" }).click();
  await fillStructuredForm(panel, body);
  await panel.getByRole("button", { name: "Create", exact: true }).click();
}

async function fillStructuredForm(container, body) {
  for (const [key, value] of Object.entries(body)) {
    const label = formLabel(key);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        assert(
          item == null || ["string", "number"].includes(typeof item),
          `Stage 20 real-Swarm E2E only supports primitive list items for ${key}`,
        );
        await container
          .getByLabel(`${label} item ${index + 1}`, { exact: true })
          .fill(item == null ? "" : String(item));
      }
      continue;
    }

    if (value && typeof value === "object") {
      const group = container.getByRole("group", { name: label, exact: true });
      const entries = Object.entries(value);
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) {
          await group.getByRole("button", { name: "Add field", exact: true }).click();
        }
        const [entryKey, entryValue] = entries[index];
        await group
          .getByLabel(`${label} key ${index + 1}`, { exact: true })
          .fill(entryKey);
        const typeControl = group.getByLabel(`${label} type ${index + 1}`, {
          exact: true,
        });
        if (typeof entryValue === "number") {
          await typeControl.selectOption("number");
        } else if (typeof entryValue === "boolean") {
          await typeControl.selectOption("boolean");
        } else {
          assert(
            typeof entryValue === "string",
            `Stage 20 real-Swarm E2E only supports primitive object values for ${key}`,
          );
        }
        const valueControl = group.getByLabel(`${label} value ${index + 1}`, {
          exact: true,
        });
        if (typeof entryValue === "boolean") {
          const checked = await valueControl.isChecked();
          if (checked !== entryValue) await valueControl.click();
        } else {
          await valueControl.fill(String(entryValue));
        }
      }
      continue;
    }

    const control = container.getByLabel(label, { exact: true });
    if (typeof value === "boolean") {
      const checked = await control.isChecked();
      if (checked !== value) await control.click();
      continue;
    }
    await control.fill(value == null ? "" : String(value));
  }
}

function formLabel(key) {
  const spaced = key
    .replace(/Ids\b/g, " IDs")
    .replace(/Id\b/g, " ID")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!spaced) return "Value";
  return spaced
    .split(/\s+/)
    .map((word, index) => {
      if (word === "ID" || word === "IDs") return word;
      const normalized = word.toLowerCase();
      return index === 0
        ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
        : normalized;
    })
    .join(" ");
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
    `${section} route did not settle cleanly`,
  );
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
    ["--workspace", "@resource-portal/api", "run", "worker:deployments"],
    {
      ...process.env,
      WORKER_ONCE: "true",
    },
  );
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (output) console.log(output);
  assert(result.exitCode === 0, output || "Deployment worker failed");
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