import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

loadDotEnv();

const prisma = new PrismaClient();
const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3001/api")
  .replace(/\/$/, "");
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const suffix = `${Date.now()}`;
const stackPrefix = "rp_";

let createdTenantId: string | undefined;
let createdVolumeId: string | undefined;
let createdAppGroupId: string | undefined;

async function main() {
  const userId = await resolveUserId();

  await preflightApi();
  await preflightSwarm();

  const tenant = await api<JsonObject>("/tenants", {
    method: "POST",
    userId,
    body: {
      name: `smoke-${suffix}`,
      displayName: "Smoke Deploy",
      contactEmail: `smoke-${suffix}@example.com`,
    },
  });
  createdTenantId = stringField(tenant, "id");

  await api(`/tenants/${createdTenantId}/quota`, {
    method: "PATCH",
    userId,
    body: {
      cpu: 2,
      memoryBytes: 536870912,
      gpu: 0,
      storageBytes: 1073741824,
      maxSingleApps: 5,
      maxVolumes: 5,
    },
  });

  const volume = await api<JsonObject>(`/tenants/${createdTenantId}/volumes`, {
    method: "POST",
    userId,
    body: {
      name: "data",
      sizeBytes: 1048576,
    },
  });
  createdVolumeId = stringField(volume, "id");

  const appGroup = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups`,
    {
      method: "POST",
      userId,
      body: {
        name: "web",
        runtimeState: "Running",
      },
    },
  );
  createdAppGroupId = stringField(appGroup, "id");

  const singleApp = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps`,
    {
      method: "POST",
      userId,
      body: {
        name: "nginx",
        image: "nginx:alpine",
        desiredReplicas: 1,
        runtimeState: "Running",
        cpu: 0.1,
        memoryBytes: 134217728,
        environment: {
          SMOKE_MODE: "true",
        },
      },
    },
  );
  const singleAppId = stringField(singleApp, "id");

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/runtime-config`,
    {
      method: "PATCH",
      userId,
      body: {
        secrets: [
          {
            name: "SMOKE_SECRET",
            value: `secret-${suffix}`,
          },
        ],
      },
    },
  );

  const variable = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/variables`,
    {
      method: "POST",
      userId,
      body: {
        name: "SMOKE_VARIABLE",
        value: `variable-${suffix}`,
      },
    },
  );

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/variable-attachments`,
    {
      method: "POST",
      userId,
      body: {
        variableId: stringField(variable, "id"),
        targetName: "SMOKE_VARIABLE",
      },
    },
  );

  const config = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/configs`,
    {
      method: "POST",
      userId,
      body: {
        name: "nginx-conf",
        content: "smoke=true\n",
      },
    },
  );

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/config-attachments`,
    {
      method: "POST",
      userId,
      body: {
        configId: stringField(config, "id"),
        targetPath: "/etc/resource-portal-smoke.conf",
      },
    },
  );

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/volume-attachments`,
    {
      method: "POST",
      userId,
      body: {
        volumeId: createdVolumeId,
        mountPath: "/smoke-data",
        mode: "ReadWrite",
      },
    },
  );

  const deployment = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/deploy`,
    {
      method: "POST",
      userId,
      idempotencyKey: `smoke-deploy-${suffix}`,
      body: {
        note: "smoke deploy",
      },
    },
  );
  const deploymentId = stringField(deployment, "id");

  await runWorkerOnce();
  await expectDeploymentStatus(userId, deploymentId, "Succeeded");

  const stackName = stackNameFor(createdAppGroupId);
  await docker(["stack", "services", stackName]);

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/runtime/stop`,
    {
      method: "POST",
      userId,
    },
  );
  await expectServiceReplicas(stackName, "nginx", "0/0");

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/runtime/start`,
    {
      method: "POST",
      userId,
    },
  );
  await expectServiceReplicas(stackName, "nginx", "1/1");

  await api(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/single-apps/${singleAppId}/runtime/restart`,
    {
      method: "POST",
      userId,
    },
  );

  const rollback = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/deployments/${deploymentId}/rollback`,
    {
      method: "POST",
      userId,
      idempotencyKey: `smoke-rollback-${suffix}`,
      body: {
        note: "smoke rollback to current version",
      },
    },
  );
  await runWorkerOnce();
  await expectDeploymentStatus(userId, stringField(rollback, "id"), "Succeeded");

  console.log("Smoke deploy completed successfully");
}

async function cleanup() {
  if (createdAppGroupId) {
    await docker(["stack", "rm", stackNameFor(createdAppGroupId)], true);
    await wait(5000);
  }

  if (createdVolumeId) {
    await docker(["volume", "rm", `rp_vol_${createdVolumeId.replaceAll("-", "_")}`], true);
  }

  if (createdTenantId) {
    await prisma.tenant.delete({ where: { id: createdTenantId } }).catch(() => undefined);
  }
}

async function resolveUserId() {
  if (process.env.SMOKE_USER_ID) {
    return process.env.SMOKE_USER_ID;
  }

  const membership = await prisma.tenantMembership.findFirst({
    where: { status: "Active" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });

  if (!membership) {
    throw new Error("SMOKE_USER_ID is required when no active membership exists");
  }

  return membership.userId;
}

async function preflightApi() {
  const response = await fetch(`${apiBaseUrl}/health`);

  if (!response.ok) {
    throw new Error(`API health failed: HTTP ${response.status}`);
  }
}

async function preflightSwarm() {
  const result = await docker([
    "info",
    "--format",
    "{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}",
  ]);
  const output = result.stdout.trim();

  if (output !== "active true") {
    throw new Error(
      `Docker context ${dockerContext} is not a Swarm manager (${output || "empty docker info"})`,
    );
  }
}

async function runWorkerOnce() {
  const result = await command("npm", ["run", "worker:deployments"], {
    ...process.env,
    WORKER_ONCE: "true",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Deployment worker failed");
  }
}

async function expectDeploymentStatus(
  userId: string,
  deploymentId: string,
  expectedStatus: string,
) {
  const deployment = await api<JsonObject>(
    `/tenants/${createdTenantId}/app-groups/${createdAppGroupId}/deployments/${deploymentId}`,
    {
      method: "GET",
      userId,
    },
  );
  const status = stringField(deployment, "status");

  if (status !== expectedStatus) {
    throw new Error(
      `Expected deployment ${deploymentId} to be ${expectedStatus}, got ${status}`,
    );
  }
}

async function expectServiceReplicas(
  stackName: string,
  serviceName: string,
  expected: string,
) {
  const result = await docker([
    "service",
    "ls",
    "--filter",
    `name=${stackName}_${serviceName}`,
    "--format",
    "{{.Replicas}}",
  ]);
  const replicas = result.stdout.trim();

  if (replicas !== expected) {
    throw new Error(
      `Expected ${stackName}_${serviceName} replicas ${expected}, got ${replicas}`,
    );
  }
}

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    userId: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method,
    headers: {
      "x-dev-user-id": options.userId,
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload: unknown = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new Error(
      `${options.method} ${path} failed: HTTP ${response.status} ${text}`,
    );
  }

  return payload as T;
}

function docker(args: string[], ignoreFailure = false) {
  return command("docker", [
    ...(dockerContext ? ["--context", dockerContext] : []),
    ...args,
  ]).then((result) => {
    if (!ignoreFailure && result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `docker ${args.join(" ")} failed`);
    }

    return result;
  });
}

function command(commandName: string, args: string[], env = process.env) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(commandName, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function stackNameFor(appGroupId: string) {
  return `${stackPrefix}${appGroupId.replaceAll("-", "_")}`;
}

function stringField(value: JsonObject, field: string) {
  const fieldValue = value[field];

  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }

  return fieldValue;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv() {
  if (!existsSync(".env")) {
    return;
  }

  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
