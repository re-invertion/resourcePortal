import { Prisma, PrismaClient } from "@prisma/client";
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
const appGroupIds: string[] = [];

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
      cpu: 100000,
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

  await verifyOversizedDeploymentRejected();
  await verifyRuntimeStartReservation();

  console.log("Stage 15 capacity admission smoke passed");
}

async function verifyOversizedDeploymentRejected() {
  const appGroup = await createAppGroup("oversized", "Running");
  const appGroupId = stringField(appGroup, "id");

  await createSingleApp(appGroupId, "oversized", {
    desiredReplicas: 100,
    runtimeState: "Running",
    cpu: 128,
    memoryBytes: 134217728,
  });

  const deployment = await createDeployment(
    appGroupId,
    `stage15-capacity-${suffix}`,
    "must fail capacity admission before stack apply",
  );
  const deploymentId = stringField(deployment, "id");

  await runWorkerOnce();

  const observed = await getDeployment(appGroupId, deploymentId);
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
  await assertStackAbsent(appGroupId, "Oversized deployment");
}

async function verifyRuntimeStartReservation() {
  const supplyCpuNano = await platformCpuNano();
  const cpuTenThousandths =
    ((supplyCpuNano * 3n) / 4n) / 100_000n;
  const workloadCpuNano = cpuTenThousandths * 100_000n;
  assert(
    cpuTenThousandths > 0n && workloadCpuNano <= supplyCpuNano,
    `Cannot construct Stage 15 runtime capacity fixture from ${supplyCpuNano} NanoCPU`,
  );
  assert(
    workloadCpuNano * 2n > supplyCpuNano,
    `Runtime capacity fixture does not overcommit when combined: supply=${supplyCpuNano}, workload=${workloadCpuNano}`,
  );
  const workloadCpu = Number(cpuTenThousandths) / 10_000;

  const baseline = await createAppGroup("runtime-baseline", "Stopped");
  const baselineAppGroupId = stringField(baseline, "id");
  const baselineSingleApp = await createSingleApp(
    baselineAppGroupId,
    "runtime-baseline",
    {
      desiredReplicas: 1,
      runtimeState: "Running",
      cpu: workloadCpu,
      memoryBytes: 134217728,
    },
  );
  const baselineSingleAppId = stringField(baselineSingleApp, "id");

  const baselineDeployment = await createDeployment(
    baselineAppGroupId,
    `stage15-runtime-baseline-${suffix}`,
    "deploy stopped workload before direct runtime start",
  );
  const baselineDeploymentId = stringField(baselineDeployment, "id");
  await runWorkerOnce();

  const baselineObserved = await getDeployment(
    baselineAppGroupId,
    baselineDeploymentId,
  );
  assert(
    baselineObserved.status === "Succeeded",
    `Expected stopped baseline deployment to succeed, got ${String(baselineObserved.status)}`,
  );

  const runtimeStart = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${baselineAppGroupId}/runtime/start`,
    { method: "POST" },
  );
  assert(
    runtimeStart.runtimeApplied === true,
    "Expected direct AppGroup runtime start to scale the deployed service",
  );

  const startedSingleApp = await prisma.singleApp.findUnique({
    where: { id: baselineSingleAppId },
    select: { actualReplicas: true, runtimeState: true },
  });
  assert(
    startedSingleApp?.runtimeState === "Running" &&
      startedSingleApp.actualReplicas === 1,
    `Expected runtime-started workload to report one actual replica, got ${JSON.stringify(startedSingleApp)}`,
  );

  const conflicting = await createAppGroup("runtime-conflict", "Running");
  const conflictingAppGroupId = stringField(conflicting, "id");
  await createSingleApp(conflictingAppGroupId, "runtime-conflict", {
    desiredReplicas: 1,
    runtimeState: "Running",
    cpu: workloadCpu,
    memoryBytes: 134217728,
  });

  const conflictingDeployment = await createDeployment(
    conflictingAppGroupId,
    `stage15-runtime-conflict-${suffix}`,
    "must count directly started stopped deployment as occupied capacity",
  );
  const conflictingDeploymentId = stringField(conflictingDeployment, "id");
  await runWorkerOnce();

  const conflictObserved = await getDeployment(
    conflictingAppGroupId,
    conflictingDeploymentId,
  );
  assert(
    conflictObserved.status === "Failed",
    `Expected conflicting deployment to fail after runtime start, got ${String(conflictObserved.status)}`,
  );
  assert(
    conflictObserved.phase === "Validating",
    `Expected runtime-accounting rejection in Validating, got ${String(conflictObserved.phase)}`,
  );
  assert(
    conflictObserved.errorCode === "InsufficientCapacity",
    `Expected runtime-started workload to reserve capacity, got ${String(conflictObserved.errorCode)}`,
  );
  assert(
    conflictObserved.renderedStack === null,
    "Conflicting deployment rendered a stack before runtime capacity rejection",
  );
  await assertStackAbsent(conflictingAppGroupId, "Conflicting deployment");

  console.log("Stage 15 runtime-start capacity regression passed");
}

async function createAppGroup(name: string, runtimeState: "Running" | "Stopped") {
  const appGroup = await api<JsonObject>(`/tenants/${tenantId}/app-groups`, {
    method: "POST",
    body: { name, runtimeState },
  });
  appGroupIds.push(stringField(appGroup, "id"));
  return appGroup;
}

async function createSingleApp(
  appGroupId: string,
  name: string,
  input: {
    desiredReplicas: number;
    runtimeState: "Running" | "Stopped";
    cpu: number;
    memoryBytes: number;
  },
) {
  return api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps`,
    {
      method: "POST",
      body: {
        name,
        image: "nginx:alpine",
        ...input,
        environment: {
          STAGE15_CAPACITY_SMOKE: "true",
        },
      },
    },
  );
}

function createDeployment(appGroupId: string, idempotencyKey: string, note: string) {
  return api<JsonObject>(`/tenants/${tenantId}/app-groups/${appGroupId}/deploy`, {
    method: "POST",
    idempotencyKey,
    body: { note },
  });
}

function getDeployment(appGroupId: string, deploymentId: string) {
  return api<DeploymentView>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deployments/${deploymentId}`,
    { method: "GET" },
  );
}

async function platformCpuNano() {
  const rows = await prisma.$queryRaw<Array<{ availableCpuNano: bigint }>>(
    Prisma.sql`
      SELECT COALESCE(SUM("availableCpuNano"), 0)::bigint AS "availableCpuNano"
      FROM "RemoteLocation"
    `,
  );
  const supply = rows[0]?.availableCpuNano ?? 0n;
  assert(supply > 0n, "Stage 15 runtime smoke found no available platform CPU");
  return supply;
}

async function assertStackAbsent(appGroupId: string, label: string) {
  const stackName = stackNameFor(appGroupId);
  const stackList = await docker(["stack", "ls", "--format", "{{.Name}}"]);
  assert(
    !stackList.stdout
      .split("\n")
      .map((value) => value.trim())
      .includes(stackName),
    `${label} created Docker stack ${stackName}`,
  );
}

async function cleanup() {
  for (const appGroupId of appGroupIds) {
    await docker(["stack", "rm", stackNameFor(appGroupId)], true);
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

function stackNameFor(appGroupId: string) {
  return `rp_${appGroupId.replaceAll("-", "_")}`;
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
