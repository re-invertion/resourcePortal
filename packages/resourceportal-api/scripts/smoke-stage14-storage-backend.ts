type JsonObject = Record<string, unknown>;

const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3000/api")
  .replace(/\/$/, "");
const userId =
  process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";

let backendId: string | undefined;
let maintenanceEnabled = false;

async function main() {
  const backends = await api<JsonObject[]>("/platform/storage-backends", {
    method: "GET",
  });

  if (backends.length !== 1) {
    throw new Error(`Expected one default StorageBackend, got ${backends.length}`);
  }

  const backend = backends[0];
  backendId = stringField(backend, "id");
  expectField(backend, "name", "default-cephfs");
  expectField(backend, "type", "CephFS");
  expectField(backend, "basePath", "/rp");
  expectField(backend, "volumeBasePath", "/rp/volumes");
  expectField(backend, "secretBasePath", "/rp/secrets");

  const validated = await api<JsonObject>(
    `/platform/storage-backends/${backendId}/validate`,
    { method: "POST" },
  );
  if (validated.status !== "Ready") {
    throw new Error(
      `StorageBackend validation failed: ${JSON.stringify(validated)}`,
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
  .finally(cleanup);
