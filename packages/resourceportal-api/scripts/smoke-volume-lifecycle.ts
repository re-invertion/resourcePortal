import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

const prisma = new PrismaClient();
const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api")
  .replace(/\/$/, "");
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const suffix = `${Date.now()}`;
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";

let createdTenantId: string | undefined;
let createdVolumeId: string | undefined;
let storagePath: string | undefined;
let dockerVolumeName: string | undefined;

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

  const volume = await api<JsonObject>(`/tenants/${createdTenantId}/volumes`, {
    method: "POST",
    body: {
      name: "lifecycle-data",
      sizeBytes: 1048576,
    },
  });
  createdVolumeId = stringField(volume, "id");
  storagePath = stringField(volume, "storagePath");
  dockerVolumeName = stringField(volume, "dockerVolumeName");

  await mkdir(storagePath, { recursive: true });
  await writeFile(join(storagePath, "stage7-usage.bin"), Buffer.alloc(8192, 1));

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

  await docker([
    "volume",
    "create",
    "--driver",
    "local",
    "--opt",
    "type=none",
    "--opt",
    "o=bind",
    "--opt",
    `device=${storagePath}`,
    dockerVolumeName,
  ]);

  await api(`/tenants/${createdTenantId}/volumes/${createdVolumeId}`, {
    method: "DELETE",
  });

  const inspect = await docker(
    ["volume", "inspect", dockerVolumeName],
    true,
  );
  if (inspect.exitCode === 0) {
    throw new Error(`Docker volume ${dockerVolumeName} still exists after DELETE`);
  }

  if (existsSync(storagePath)) {
    throw new Error(`Storage path ${storagePath} still exists after DELETE`);
  }

  createdVolumeId = undefined;
  storagePath = undefined;
  dockerVolumeName = undefined;
  console.log("Stage 7 volume lifecycle smoke completed successfully");
}

async function cleanup() {
  if (dockerVolumeName) {
    await docker(["volume", "rm", dockerVolumeName], true);
  }

  if (storagePath) {
    await rm(storagePath, { recursive: true, force: true }).catch(() => undefined);
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

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
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

function command(commandName: string, args: string[]) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolveCommand) => {
      const child = spawn(commandName, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        resolveCommand({ exitCode: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        resolveCommand({
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

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
