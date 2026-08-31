import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCephFsLocalPath } from "../src/storage-backends/storage-backend.logic";

type JsonObject = Record<string, unknown>;

const prisma = new PrismaClient();
const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api")
  .replace(/\/$/, "");
const cephFsMountRoot = process.env.CEPHFS_MOUNT_ROOT ?? "/";
const suffix = `${Date.now()}`;
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";

let createdTenantId: string | undefined;
let createdVolumeId: string | undefined;
let storagePath: string | undefined;
let physicalStoragePath: string | undefined;

async function main() {
  const tenant = await api<JsonObject>("/tenants", {
    method: "POST",
    body: {
      name: `stage7-smoke-${suffix}`,
      displayName: "Stage 7 Volume Smoke",
      contactEmail: `stage7-smoke-${suffix}@example.com`,
    },
  });
  createdTenantId = stringField(tenant, "id");

  await api(`/tenants/${createdTenantId}/quota`, {
    method: "PATCH",
    body: {
      cpu: 1,
      memoryBytes: 268435456,
      gpu: 0,
      storageBytes: 1073741824,
      maxSingleApps: 1,
      maxVolumes: 2,
    },
  });

  const createOperation = await api<JsonObject>(
    `/tenants/${createdTenantId}/volumes`,
    {
      method: "POST",
      idempotencyKey: `stage7-volume-create-${suffix}`,
      body: {
        name: "lifecycle-data",
        sizeBytes: 1048576,
      },
    },
  );
  const createOperationId = stringField(createOperation, "id");
  await runOperationWorkerOnce();
  const completedCreate = await expectOperationSucceeded(createOperationId);
  createdVolumeId = stringField(completedCreate, "resourceId");

  const volume = await api<JsonObject>(
    `/tenants/${createdTenantId}/volumes/${createdVolumeId}`,
    { method: "GET" },
  );
  storagePath = stringField(volume, "storagePath");
  physicalStoragePath = resolveCephFsLocalPath(
    cephFsMountRoot,
    "/rp",
    storagePath,
  );

  await mkdir(physicalStoragePath, { recursive: true });
  await writeFile(
    join(physicalStoragePath, "stage7-usage.bin"),
    Buffer.alloc(8192, 1),
  );

  const measured = await api<JsonObject>(
    `/tenants/${createdTenantId}/volumes/${createdVolumeId}`,
    { method: "GET" },
  );
  const usedSizeBytes = BigInt(stringField(measured, "usedSizeBytes"));

  if (usedSizeBytes < 8192n) {
    throw new Error(
      `Expected usedSizeBytes to include 8192 bytes, got ${usedSizeBytes}`,
    );
  }

  const deleteOperation = await api<JsonObject>(
    `/tenants/${createdTenantId}/volumes/${createdVolumeId}`,
    {
      method: "DELETE",
      idempotencyKey: `stage7-volume-delete-${suffix}`,
    },
  );
  const deleteOperationId = stringField(deleteOperation, "id");
  await runOperationWorkerOnce();
  await expectOperationSucceeded(deleteOperationId);

  if (existsSync(physicalStoragePath)) {
    throw new Error(
      `Physical storage path ${physicalStoragePath} still exists after DELETE`,
    );
  }

  createdVolumeId = undefined;
  storagePath = undefined;
  physicalStoragePath = undefined;
  console.log("Stage 7 volume lifecycle smoke completed successfully through Stage 14 StorageBackend");
}

async function cleanup() {
  if (physicalStoragePath) {
    await rm(physicalStoragePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  if (createdVolumeId) {
    await prisma.volume
      .delete({ where: { id: createdVolumeId } })
      .catch(() => undefined);
  }

  if (createdTenantId) {
    await prisma.tenant
      .delete({ where: { id: createdTenantId } })
      .catch(() => undefined);
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

async function expectOperationSucceeded(operationId: string) {
  const operation = await api<JsonObject>(
    `/tenants/${createdTenantId}/operations/${operationId}`,
    { method: "GET" },
  );
  const status = stringField(operation, "status");

  if (status !== "Succeeded") {
    throw new Error(
      `Expected operation ${operationId} to succeed, got ${status}: ${JSON.stringify(operation)}`,
    );
  }

  return operation;
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

function stringField(value: JsonObject, field: string) {
  const fieldValue = value[field];

  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }

  return fieldValue;
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
