import { execFileSync } from "node:child_process";

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
  memoryBytes: string;
};

async function main() {
  const nodeId = docker(["info", "--format", "{{.Swarm.NodeID}}"]);
  assert(nodeId.length > 0, "Docker Swarm did not expose the local node id");

  const reconcile = await request("/platform/swarm-cluster/reconcile", "POST");
  expectSuccess(reconcile, "reconcile Swarm infrastructure");
  const reconcilePayload = objectPayload(reconcile.payload);
  assert(
    numberField(reconcilePayload, "nodeCount") >= 1,
    "Stage 13 reconcile did not discover any nodes",
  );
  assert(
    numberField(reconcilePayload, "managerCount") >= 1,
    "Stage 13 reconcile did not discover a manager",
  );

  const remoteLocation = await findRemoteLocation(nodeId);
  assert(remoteLocation.role === "Manager", "Local Swarm node was not mapped as Manager");
  assert(remoteLocation.status === "Ready", "Local Swarm node was not Ready");
  assert(BigInt(remoteLocation.cpuNano) > 0n, "Remote Location CPU capacity was not captured");
  assert(
    BigInt(remoteLocation.memoryBytes) > 0n,
    "Remote Location memory capacity was not captured",
  );

  let maintenanceEnabled = false;
  let restoreApiError: Error | null = null;
  try {
    const enable = await request(
      `/platform/remote-locations/${remoteLocation.id}/maintenance`,
      "PATCH",
      { enabled: true },
    );
    expectSuccess(enable, "enable Remote Location maintenance");
    maintenanceEnabled = true;

    const drained = remoteLocationPayload(enable.payload);
    assert(drained.maintenance, "Remote Location maintenance flag was not enabled");
    assert(drained.availability === "Drain", "Remote Location was not drained");
    assert(
      docker(["node", "inspect", nodeId, "--format", "{{.Spec.Availability}}"])
        .trim()
        .toLowerCase() === "drain",
      "Docker node availability did not change to drain",
    );

    const drainedReconcile = await request(
      "/platform/swarm-cluster/reconcile",
      "POST",
    );
    expectSuccess(drainedReconcile, "reconcile drained Remote Location");
    const observedDrain = await findRemoteLocation(nodeId);
    assert(
      observedDrain.maintenance && observedDrain.availability === "Drain",
      "Reconcile did not preserve RP-managed maintenance",
    );
  } finally {
    if (maintenanceEnabled) {
      try {
        const disable = await request(
          `/platform/remote-locations/${remoteLocation.id}/maintenance`,
          "PATCH",
          { enabled: false },
        );
        expectSuccess(disable, "disable Remote Location maintenance");
      } catch (error) {
        restoreApiError =
          error instanceof Error ? error : new Error("maintenance restore failed");
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

    const restoredReconcile = await request(
      "/platform/swarm-cluster/reconcile",
      "POST",
    );
    expectSuccess(restoredReconcile, "reconcile restored Remote Location");
  }

  const restored = await findRemoteLocation(nodeId);
  assert(!restored.maintenance, "Remote Location maintenance flag stayed enabled");
  assert(restored.availability === "Active", "Remote Location did not return to Active");
  assert(restored.health === "Healthy", "Remote Location did not return to Healthy");

  if (restoreApiError) {
    throw restoreApiError;
  }

  console.log("Stage 13 platform infrastructure smoke passed");
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

async function request(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-dev-user-id": userId,
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
    "memoryBytes",
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
