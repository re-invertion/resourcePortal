import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";

type JsonObject = Record<string, unknown>;

const prisma = new PrismaClient();

const apiBaseUrl = (
  process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api"
).replace(/\/$/, "");
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";

let backendId: string | undefined;
let maintenanceEnabled = false;

async function main() {
  const backends = await api<JsonObject[]>("/platform/storage-backends", {
    method: "GET",
  });

  if (backends.length !== 1) {
    throw new Error(
      `Expected one default StorageBackend, got ${backends.length}`,
    );
  }

  const backend = backends[0];
  backendId = stringField(backend, "id");
  expectField(backend, "name", "default-local-filesystem");
  expectField(backend, "type", "LocalFilesystem");
  expectField(backend, "basePath", "/srv/resource-portal/storage");
  expectField(
    backend,
    "volumeBasePath",
    "/srv/resource-portal/storage/volumes",
  );
  expectField(
    backend,
    "secretBasePath",
    "/srv/resource-portal/storage/secrets",
  );

  const validationOperation = await api<JsonObject>(
    `/platform/storage-backends/${backendId}/validate`,
    { method: "POST" },
  );
  const validationOperationId = stringField(validationOperation, "id");
  await runOperationToTerminal(validationOperationId, "Succeeded");

  const validated = await api<JsonObject>(
    `/platform/storage-backends/${backendId}`,
    { method: "GET" },
  );
  if (validated.status !== "Ready") {
    throw new Error(
      `StorageBackend validation did not produce Ready status: ${JSON.stringify(validated)}`,
    );
  }

  const health = stringField(validated, "health");
  if (health !== "Healthy" && health !== "Degraded") {
    throw new Error(`Expected writable StorageBackend health, got ${health}`);
  }

  const total = BigInt(stringField(validated, "capacityTotal"));
  const available = BigInt(stringField(validated, "capacityAvailable"));
  if (total <= 0n || available < 0n || available > total) {
    throw new Error(
      `Invalid StorageBackend capacity total=${total} available=${available}`,
    );
  }

  const maintenanceOn = await api<JsonObject>(
    `/platform/storage-backends/${backendId}/maintenance`,
    { method: "PATCH", body: { enabled: true } },
  );
  maintenanceEnabled = true;
  expectBooleanField(maintenanceOn, "maintenance", true);

  const maintenanceOff = await api<JsonObject>(
    `/platform/storage-backends/${backendId}/maintenance`,
    { method: "PATCH", body: { enabled: false } },
  );
  maintenanceEnabled = false;
  expectBooleanField(maintenanceOff, "maintenance", false);

  console.log("Stage 14 StorageBackend smoke completed successfully");
}

async function cleanup() {
  if (!backendId || !maintenanceEnabled) {
    return;
  }

  await api(`/platform/storage-backends/${backendId}/maintenance`, {
    method: "PATCH",
    body: { enabled: false },
  }).catch(() => undefined);
}

async function runOperationToTerminal(
  operationId: string,
  expectedStatus: string,
) {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const operation = await prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        status: true,
        attempt: true,
        maxAttempts: true,
        nextAttemptAt: true,
        errorCode: true,
        errorMessage: true,
      },
    });
    if (!operation) {
      throw new Error(`Operation ${operationId} was not found`);
    }
    if (operation.status === expectedStatus) return;
    if (
      operation.status === "Failed" ||
      operation.status === "RollbackFailed" ||
      operation.status === "RolledBack"
    ) {
      throw new Error(
        `Operation ${operationId} reached ${operation.status}, expected ${expectedStatus}: ${operation.errorCode ?? "no-code"} ${operation.errorMessage ?? ""}`,
      );
    }

    const retryWaitMs = Math.max(
      0,
      operation.nextAttemptAt.getTime() - Date.now(),
    );
    if (retryWaitMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(retryWaitMs + 50, 5_000)),
      );
    }
    await runOperationWorkerOnce();
  }

  throw new Error(
    `Operation ${operationId} did not reach ${expectedStatus} after 10 worker iterations`,
  );
}

async function runOperationWorkerOnce() {
  const workerEnv = {
    ...process.env,
    WORKER_ONCE: "true",
  };
  const privileged =
    process.env.STORAGE_SMOKE_PRIVILEGED_WORKER?.trim().toLowerCase() ===
    "true";

  let result;
  if (privileged) {
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) {
      throw new Error("Privileged storage smoke requires npm_execpath");
    }
    result = await command(
      "sudo",
      ["-E", process.execPath, npmExecPath, "run", "worker"],
      workerEnv,
    );
  } else {
    result = await command("npm", ["run", "worker"], workerEnv);
  }

  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (output) console.log(output);
  if (result.exitCode !== 0) {
    throw new Error(output || "Operation worker failed");
  }
}

function command(
  commandName: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
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

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH";
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method,
    headers: {
      "x-dev-user-id": userId,
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

function stringField(value: JsonObject, field: string) {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }
  return fieldValue;
}

function expectField(value: JsonObject, field: string, expected: string) {
  const actual = stringField(value, field);
  if (actual !== expected) {
    throw new Error(`Expected ${field}=${expected}, got ${actual}`);
  }
}

function expectBooleanField(
  value: JsonObject,
  field: string,
  expected: boolean,
) {
  const actual = value[field];
  if (actual !== expected) {
    throw new Error(`Expected ${field}=${expected}, got ${String(actual)}`);
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
