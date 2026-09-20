import { PrismaClient } from "@prisma/client";
import { execFileSync, spawn } from "node:child_process";

const prisma = new PrismaClient();
const apiBaseUrl = (
  process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api"
).replace(/\/$/, "");
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";

type ApiResult = {
  status: number;
  payload: unknown;
};

type RemoteLocation = {
  id: string;
  swarmNodeId: string;
  hostname: string;
  role: string;
  status: string;
  availability: string;
  health: string;
  maintenance: boolean;
  cpuNano: string;
  availableCpuNano: string;
  memoryBytes: string;
  availableMemoryBytes: string;
};

async function main() {
  const nodeId = docker(["info", "--format", "{{.Swarm.NodeID}}"]);
  assert(nodeId.length > 0, "Docker Swarm did not expose the local node id");

  await enqueueAndDrain(
    "/platform/swarm-cluster/reconcile",
    "POST",
    undefined,
    "reconcile Swarm infrastructure",
  );
  const cluster = await request("/platform/swarm-cluster", "GET");
  expectSuccess(cluster, "read reconciled Swarm infrastructure");
  const clusterPayload = objectPayload(cluster.payload);
  assert(
    numberField(clusterPayload, "nodeCount") >= 1,
    "Stage 13 reconcile did not discover any nodes",
  );
  assert(
    numberField(clusterPayload, "managerCount") >= 1,
    "Stage 13 reconcile did not discover a manager",
  );

  const remoteLocation = await findRemoteLocation(nodeId);
  assert(
    remoteLocation.role === "Manager",
    "Local Swarm node was not mapped as Manager",
  );
  assert(remoteLocation.status === "Ready", "Local Swarm node was not Ready");
  assert(
    BigInt(remoteLocation.cpuNano) > 0n,
    "Remote Location CPU capacity was not captured",
  );
  assert(
    BigInt(remoteLocation.availableCpuNano) === BigInt(remoteLocation.cpuNano),
    "Active Remote Location available CPU did not match total schedulable CPU",
  );
  assert(
    BigInt(remoteLocation.memoryBytes) > 0n,
    "Remote Location memory capacity was not captured",
  );
  assert(
    BigInt(remoteLocation.availableMemoryBytes) ===
      BigInt(remoteLocation.memoryBytes),
    "Active Remote Location available memory did not match total schedulable memory",
  );

  let maintenanceEnabled = false;
  let restoreApiError: Error | null = null;
  try {
    await enqueueAndDrain(
      `/platform/remote-locations/${remoteLocation.id}/maintenance`,
      "PATCH",
      { enabled: true },
      "enable Remote Location maintenance",
    );
    maintenanceEnabled = true;

    const drained = await getRemoteLocation(remoteLocation.id);
    assert(
      drained.maintenance,
      "Remote Location maintenance flag was not enabled",
    );
    assert(drained.availability === "Drain", "Remote Location was not drained");
    assert(
      BigInt(drained.availableCpuNano) === 0n &&
        BigInt(drained.availableMemoryBytes) === 0n,
      "Drained Remote Location still exposed schedulable CPU or memory",
    );
    assert(
      docker(["node", "inspect", nodeId, "--format", "{{.Spec.Availability}}"])
        .trim()
        .toLowerCase() === "drain",
      "Docker node availability did not change to drain",
    );

    await enqueueAndDrain(
      "/platform/swarm-cluster/reconcile",
      "POST",
      undefined,
      "reconcile drained Remote Location",
    );
    const observedDrain = await findRemoteLocation(nodeId);
    assert(
      observedDrain.maintenance && observedDrain.availability === "Drain",
      "Reconcile did not preserve RP-managed maintenance",
    );
    assert(
      BigInt(observedDrain.availableCpuNano) === 0n &&
        BigInt(observedDrain.availableMemoryBytes) === 0n,
      "Reconcile restored schedulable capacity while node remained drained",
    );
  } finally {
    if (maintenanceEnabled) {
      try {
        await enqueueAndDrain(
          `/platform/remote-locations/${remoteLocation.id}/maintenance`,
          "PATCH",
          { enabled: false },
          "disable Remote Location maintenance",
        );
      } catch (error) {
        restoreApiError =
          error instanceof Error
            ? error
            : new Error("maintenance restore failed");
      }
    }

    try {
      docker(["node", "update", "--availability", "active", nodeId]);
    } catch {
      // The assertion below reports restoration failure with the observed state.
    }

    const restoredAvailability = docker([
      "node",
      "inspect",
      nodeId,
      "--format",
      "{{.Spec.Availability}}",
    ])
      .trim()
      .toLowerCase();
    assert(
      restoredAvailability === "active",
      `Docker node availability was not restored: ${restoredAvailability}`,
    );

    await enqueueAndDrain(
      "/platform/swarm-cluster/reconcile",
      "POST",
      undefined,
      "reconcile restored Remote Location",
    );
  }

  const restored = await findRemoteLocation(nodeId);
  assert(
    !restored.maintenance,
    "Remote Location maintenance flag stayed enabled",
  );
  assert(
    restored.availability === "Active",
    "Remote Location did not return to Active",
  );
  assert(
    restored.health === "Healthy",
    "Remote Location did not return to Healthy",
  );
  assert(
    BigInt(restored.availableCpuNano) === BigInt(restored.cpuNano) &&
      BigInt(restored.availableMemoryBytes) === BigInt(restored.memoryBytes),
    "Restored Remote Location did not recover schedulable capacity",
  );

  if (restoreApiError) {
    throw restoreApiError;
  }

  console.log("Stage 13 platform infrastructure smoke passed");
}

async function enqueueAndDrain(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  label: string,
) {
  const queued = await request(path, method, body);
  expectSuccess(queued, label);
  const operationId = stringField(objectPayload(queued.payload), "id");
  await runOperationToTerminal(operationId, "Succeeded");
}

async function runOperationToTerminal(
  operationId: string,
  expectedStatus: string,
) {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const operation = await prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        status: true,
        nextAttemptAt: true,
        errorCode: true,
        errorMessage: true,
      },
    });
    assert(operation, `Operation ${operationId} was not found`);

    if (operation.status === expectedStatus) {
      return;
    }
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
    await runWorkerOnce();
  }

  throw new Error(
    `Operation ${operationId} did not reach ${expectedStatus} after 12 worker iterations`,
  );
}

async function runWorkerOnce() {
  const result = await command("npm", ["run", "worker"], {
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
    throw new Error(output || "ResourcePortal worker failed");
  }
}

async function findRemoteLocation(nodeId: string) {
  const result = await request("/platform/remote-locations", "GET");
  expectSuccess(result, "list Remote Locations");
  if (!Array.isArray(result.payload)) {
    throw new Error("Remote Location list response was not an array");
  }

  const remoteLocation = result.payload.find(
    (value): value is RemoteLocation =>
      Boolean(value) &&
      typeof value === "object" &&
      (value as { swarmNodeId?: unknown }).swarmNodeId === nodeId,
  );
  if (!remoteLocation) {
    throw new Error(`Remote Location for Docker node ${nodeId} was not found`);
  }
  return remoteLocation;
}

async function getRemoteLocation(remoteLocationId: string) {
  const result = await request(
    `/platform/remote-locations/${remoteLocationId}`,
    "GET",
  );
  expectSuccess(result, "read Remote Location");
  return remoteLocationPayload(result.payload);
}

async function request(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      "x-dev-user-id": userId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  return { status: response.status, payload };
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

function docker(args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function expectSuccess(result: ApiResult, operation: string) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `${operation} failed with HTTP ${result.status}: ${JSON.stringify(result.payload)}`,
    );
  }
}

function objectPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected API object response");
  }
  return value as Record<string, unknown>;
}

function remoteLocationPayload(value: unknown): RemoteLocation {
  const payload = objectPayload(value);
  const requiredStrings = [
    "id",
    "swarmNodeId",
    "hostname",
    "role",
    "status",
    "availability",
    "health",
    "cpuNano",
    "availableCpuNano",
    "memoryBytes",
    "availableMemoryBytes",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof payload[field] !== "string") {
      throw new Error(`Remote Location response is missing ${field}`);
    }
  }
  if (typeof payload.maintenance !== "boolean") {
    throw new Error("Remote Location response is missing maintenance");
  }
  return payload as unknown as RemoteLocation;
}

function stringField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${field}`);
  }
  return value;
}

function numberField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== "number") {
    throw new Error(`Expected numeric field ${field}`);
  }
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
