import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const prisma = new PrismaClient();
const apiBaseUrl = (
  process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api"
).replace(/\/$/, "");
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";
const cephFsMountRoot = process.env.CEPHFS_MOUNT_ROOT ?? "/tmp/resource-portal";
const suffix = `${Date.now()}`;

let tenantId: string | undefined;
let backendId: string | undefined;
let maintenanceEnabled = false;
let createdVolumeId: string | undefined;

type JsonObject = Record<string, unknown>;

type OperationView = JsonObject & {
  id?: unknown;
  status?: unknown;
  attempt?: unknown;
  errorCode?: unknown;
  nextAttemptAt?: unknown;
  resourceId?: unknown;
};

type OperationEventView = JsonObject & {
  event?: unknown;
};

async function main() {
  await preflightApi();

  const backends = await api<JsonObject[]>("/platform/storage-backends", {
    method: "GET",
  });
  assert(backends.length === 1, `Expected one StorageBackend, got ${backends.length}`);
  backendId = stringField(backends[0], "id");

  const validated = await api<JsonObject>(
    `/platform/storage-backends/${backendId}/validate`,
    { method: "POST" },
  );
  assert(
    validated.status === "Ready",
    `Stage 16 requires writable StorageBackend, got ${String(validated.status)}`,
  );

  const tenant = await api<JsonObject>("/tenants", {
    method: "POST",
    body: {
      name: `stage16-${suffix}`,
      displayName: "Stage 16 Operations Smoke",
      contactEmail: `stage16-${suffix}@example.local`,
    },
  });
  tenantId = stringField(tenant, "id");

  await api(`/tenants/${tenantId}/quota`, {
    method: "PATCH",
    body: {
      cpu: 100,
      memoryBytes: 1073741824,
      gpu: 0,
      storageBytes: 1073741824,
      maxSingleApps: 2,
      maxVolumes: 4,
    },
  });

  await setMaintenance(true);

  const idempotencyKey = `stage16-volume-create-${suffix}`;
  const createInput = {
    method: "POST" as const,
    idempotencyKey,
    body: {
      name: `stage16-volume-${suffix}`,
      description: "Stage 16 real operation smoke",
      sizeBytes: 1048576,
    },
  };

  const first = await api<OperationView>(`/tenants/${tenantId}/volumes`, createInput);
  const duplicate = await api<OperationView>(
    `/tenants/${tenantId}/volumes`,
    createInput,
  );
  const operationId = stringField(first, "id");
  assert(
    stringField(duplicate, "id") === operationId,
    "Idempotency-Key created more than one VOLUME_CREATE operation",
  );
  assert(first.status === "Pending", `Expected Pending operation, got ${String(first.status)}`);

  const listed = await api<OperationView[]>(`/tenants/${tenantId}/operations`, {
    method: "GET",
  });
  assert(
    listed.filter((operation) => operation.id === operationId).length === 1,
    "Operations API did not return exactly one idempotent create operation",
  );

  await runOperationWorkerOnce();

  const retrying = await getOperation(operationId);
  assert(
    retrying.status === "Pending",
    `Expected retryable operation to return to Pending, got ${String(retrying.status)}`,
  );
  assert(retrying.attempt === 1, `Expected attempt=1, got ${String(retrying.attempt)}`);
  assert(
    retrying.errorCode === "PlatformUnavailable",
    `Expected PlatformUnavailable retry classification, got ${String(retrying.errorCode)}`,
  );
  assert(
    typeof retrying.nextAttemptAt === "string" || retrying.nextAttemptAt instanceof Date,
    "Retry did not persist nextAttemptAt",
  );

  await assertEvents(operationId, [
    "OperationCreated",
    "OperationClaimed",
    "ExecutionStarted",
    "RetryScheduled",
  ]);

  await setMaintenance(false);
  await prisma.$executeRawUnsafe(
    'UPDATE "Operation" SET "nextAttemptAt" = NOW() WHERE "id" = $1::uuid',
    operationId,
  );

  await runOperationWorkerOnce();

  const succeeded = await getOperation(operationId);
  assert(
    succeeded.status === "Succeeded",
    `Expected VOLUME_CREATE to succeed after retry, got ${String(succeeded.status)}`,
  );
  createdVolumeId = stringField(succeeded, "resourceId");

  const volume = await api<JsonObject>(
    `/tenants/${tenantId}/volumes/${createdVolumeId}`,
    { method: "GET" },
  );
  assert(volume.status === "Ready", `Expected Ready Volume, got ${String(volume.status)}`);
  assert(
    stringField(volume, "sizeBytes") === "1048576",
    `Unexpected Volume size ${String(volume.sizeBytes)}`,
  );

  await assertEvents(operationId, ["ExecutionSucceeded"]);

  const deleteOperation = await api<OperationView>(
    `/tenants/${tenantId}/volumes/${createdVolumeId}`,
    {
      method: "DELETE",
      idempotencyKey: `stage16-volume-delete-${suffix}`,
    },
  );
  const deleteOperationId = stringField(deleteOperation, "id");
  await runOperationWorkerOnce();

  const deleted = await getOperation(deleteOperationId);
  assert(
    deleted.status === "Succeeded",
    `Expected VOLUME_DELETE operation to succeed, got ${String(deleted.status)}`,
  );
  await assertNotFound(`/tenants/${tenantId}/volumes/${createdVolumeId}`);
  createdVolumeId = undefined;

  console.log("Stage 16 operations/jobs smoke passed");
}

async function getOperation(operationId: string) {
  return api<OperationView>(
    `/tenants/${tenantId}/operations/${operationId}`,
    { method: "GET" },
  );
}

async function assertEvents(operationId: string, expected: string[]) {
  const events = await api<OperationEventView[]>(
    `/tenants/${tenantId}/operations/${operationId}/events`,
    { method: "GET" },
  );
  const names = new Set(events.map((event) => event.event));
  for (const event of expected) {
    assert(names.has(event), `Missing OperationEvent ${event}`);
  }
}

async function setMaintenance(enabled: boolean) {
  if (!backendId) {
    throw new Error("StorageBackend id is not initialized");
  }
  await api(`/platform/storage-backends/${backendId}/maintenance`, {
    method: "PATCH",
    body: { enabled },
  });
  maintenanceEnabled = enabled;
}

async function cleanup() {
  if (maintenanceEnabled && backendId) {
    await setMaintenance(false).catch(() => undefined);
  }

  if (tenantId) {
    const volumes = await prisma.volume
      .findMany({
        where: { tenantId },
        select: { dockerVolumeName: true, storagePath: true },
      })
      .catch(() => []);

    for (const volume of volumes) {
      await command("docker", ["volume", "rm", "-f", volume.dockerVolumeName]).catch(
        () => undefined,
      );
      const physicalPath = join(cephFsMountRoot, volume.storagePath.replace(/^\/+/, ""));
      await rm(physicalPath, { recursive: true, force: true }).catch(() => undefined);
    }

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

async function runOperationWorkerOnce() {
  const result = await command("npm", ["run", "worker:operations"], {
    ...process.env,
    OPERATION_WORKER_ONCE: "true",
  });
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (output) {
    console.log(output);
  }
  if (result.exitCode !== 0) {
    throw new Error(output || "Operation worker failed");
  }
}

async function assertNotFound(path: string) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { "x-dev-user-id": userId },
  });
  assert(response.status === 404, `Expected HTTP 404 for ${path}, got ${response.status}`);
}

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
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
