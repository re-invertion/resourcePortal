import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";

const prisma = new PrismaClient();
const apiBaseUrl = (
  process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api"
).replace(/\/$/, "");
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const suffix = `${Date.now()}`;

let tenantId: string | undefined;
let appGroupId: string | undefined;

type JsonObject = Record<string, unknown>;

type DeploymentView = JsonObject & {
  status?: unknown;
  phase?: unknown;
  errorCode?: unknown;
  renderedStack?: unknown;
};

async function main() {
  await preflightApi();

  const reconcile = await api<JsonObject>("/platform/swarm-cluster/reconcile", {
    method: "POST",
  });
  if (typeof reconcile.health !== "string") {
    throw new Error("Stage 15 preflight reconcile did not return Swarm health");
  }

  const tenant = await api<JsonObject>("/tenants", {
    method: "POST",
    body: {
      name: `stage15-${suffix}`,
      displayName: "Stage 15 Capacity Smoke",
      contactEmail: `stage15-${suffix}@example.local`,
    },
  });
  tenantId = stringField(tenant, "id");

  await api(`/tenants/${tenantId}/quota`, {
    method: "PATCH",
    body: {
      cpu: 12800,
      memoryBytes: 53687091200,
      gpu: 0,
      storageBytes: 1073741824,
      maxSingleApps: 5,
      maxVolumes: 5,
    },
  });

  await api(`/tenants/${tenantId}/billing/top-up`, {
    method: "POST",
    body: {
      amount: 100,
      reference: "stage15 capacity smoke fixture",
    },
  });

  const appGroup = await api<JsonObject>(`/tenants/${tenantId}/app-groups`, {
    method: "POST",
    body: {
      name: "oversized",
      runtimeState: "Running",
    },
  });
  appGroupId = stringField(appGroup, "id");

  await api(`/tenants/${tenantId}/app-groups/${appGroupId}/single-apps`, {
    method: "POST",
    body: {
      name: "oversized",
      image: "nginx:alpine",
      desiredReplicas: 100,
      runtimeState: "Running",
      cpu: 128,
      memoryBytes: 134217728,
      environment: {
        STAGE15_CAPACITY_SMOKE: "true",
      },
    },
  });

  const deployment = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deploy`,
    {
      method: "POST",
      idempotencyKey: `stage15-capacity-${suffix}`,
      body: { note: "must fail capacity admission before stack apply" },
    },
  );
  const deploymentId = stringField(deployment, "id");

  await runWorkerOnce();

  const observed = await api<DeploymentView>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deployments/${deploymentId}`,
    { method: "GET" },
  );

  assert(
    observed.status === "Failed",
    `Expected oversized deployment to fail, got ${String(observed.status)}`,
  );
  assert(
    observed.phase === "Validating",
    `Expected capacity failure in Validating, got ${String(observed.phase)}`,
  );
  assert(
    observed.errorCode === "InsufficientCapacity",
    `Expected InsufficientCapacity, got ${String(observed.errorCode)}`,
  );
  assert(
    observed.renderedStack === null,
    "Oversized deployment rendered a stack before capacity rejection",
  );

  const stackName = `rp_${appGroupId.replaceAll("-", "_")}`;
  const stackList = await docker(["stack", "ls", "--format", "{{.Name}}"]);
  assert(
    !stackList.stdout
      .split("\n")
      .map((value) => value.trim())
      .includes(stackName),
    `Oversized deployment created Docker stack ${stackName}`,
  );

  console.log("Stage 15 capacity admission smoke passed");
}

async function cleanup() {
  if (appGroupId) {
    const stackName = `rp_${appGroupId.replaceAll("-", "_")}`;
    await docker(["stack", "rm", stackName], true);
  }
  if (tenantId) {
    await prisma.tenant
      .delete({ where: { id: tenantId } })
      .catch(() => undefined);
  }
}

async function preflightApi() {
  const response = await fetch(`${apiBaseUrl}/health`);
  if (!response.ok) {
    throw new Error(`API health failed: HTTP ${response.status}`);
  }
}

async function runWorkerOnce() {
  const result = await command("npm", ["run", "worker:deployments"], {
    ...process.env,
    WORKER_ONCE: "true",
  });
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (output) {
    console.log(output);
  }
  if (result.exitCode !== 0) {
    throw new Error(output || "Deployment worker failed");
  }
}

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH";
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method,
    headers: {
      "x-dev-user-id": userId,
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
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
      throw new Error(
        result.stderr || result.stdout || `docker ${args.join(" ")} failed`,
      );
    }
    return result;
  });
}

function command(commandName: string, args: string[], env = process.env) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve) => {
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
    },
  );
}

function stringField(value: JsonObject, field: string) {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }
  return fieldValue;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
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
