import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3001/api").replace(/\/$/, "");
const userId = process.env.SMOKE_USER_ID ?? "11111111-1111-4111-8111-111111111111";
const suffix = Date.now().toString();

type ApiResult = {
  status: number;
  payload: unknown;
};

async function main() {
  await verifyConcurrentSingleAppCreate();
  await verifyConcurrentSingleAppUpdate();
  await verifyConcurrentVolumeCreate();
  await verifyConcurrentVolumeResize();
  console.log("Stage 11 quota concurrency smoke passed");
}

async function verifyConcurrentSingleAppCreate() {
  const tenantId = await createTenant("singleapp-create");
  await setQuota(tenantId, {
    cpu: 64,
    memoryBytes: 68719476736,
    gpu: 0,
    storageBytes: 68719476736,
    maxSingleApps: 1,
    maxVolumes: 10,
  });
  await topUp(tenantId);
  const appGroupId = await createAppGroup(tenantId, "create-race");

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      request(
        `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps`,
        "POST",
        {
          name: `app-${index}`,
          image: "nginx:alpine",
          desiredReplicas: 1,
          runtimeState: "Stopped",
          cpu: 0.1,
          memoryBytes: 67108864,
        },
      ),
    ),
  );

  assertExactlyOneQuotaWinner(results, "concurrent SingleApp create");
  const count = await prisma.singleApp.count({ where: { appGroupId } });
  assert(count === 1, `Concurrent SingleApp create persisted ${count} apps; expected 1`);
}

async function verifyConcurrentSingleAppUpdate() {
  const tenantId = await createTenant("singleapp-update");
  await setQuota(tenantId, {
    cpu: 2,
    memoryBytes: 68719476736,
    gpu: 0,
    storageBytes: 68719476736,
    maxSingleApps: 10,
    maxVolumes: 10,
  });
  await topUp(tenantId);
  const appGroupId = await createAppGroup(tenantId, "update-race");
  const firstId = await createSingleApp(tenantId, appGroupId, "first", 0.5);
  const secondId = await createSingleApp(tenantId, appGroupId, "second", 0.5);

  const results = await Promise.all([
    request(
      `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${firstId}`,
      "PATCH",
      { cpu: 1.5 },
    ),
    request(
      `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${secondId}`,
      "PATCH",
      { cpu: 1.5 },
    ),
  ]);

  assertExactlyOneQuotaWinner(results, "concurrent SingleApp update");
  const apps = await prisma.singleApp.findMany({
    where: { appGroupId },
    select: { cpu: true, desiredReplicas: true },
  });
  const cpu = apps.reduce((sum, app) => sum + Number(app.cpu) * app.desiredReplicas, 0);
  assert(cpu <= 2, `Concurrent SingleApp update exceeded CPU quota: ${cpu} > 2`);
}

async function verifyConcurrentVolumeCreate() {
  const tenantId = await createTenant("volume-create");
  await setQuota(tenantId, {
    cpu: 64,
    memoryBytes: 68719476736,
    gpu: 0,
    storageBytes: 68719476736,
    maxSingleApps: 10,
    maxVolumes: 1,
  });
  await topUp(tenantId);

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      request(`/tenants/${tenantId}/volumes`, "POST", {
        name: `volume-${index}`,
        sizeBytes: 1048576,
      }),
    ),
  );

  assertExactlyOneQuotaWinner(results, "concurrent Volume create");
  const count = await prisma.volume.count({ where: { tenantId } });
  assert(count === 1, `Concurrent Volume create persisted ${count} volumes; expected 1`);
}

async function verifyConcurrentVolumeResize() {
  const tenantId = await createTenant("volume-resize");
  await setQuota(tenantId, {
    cpu: 64,
    memoryBytes: 68719476736,
    gpu: 0,
    storageBytes: 157286400,
    maxSingleApps: 10,
    maxVolumes: 10,
  });
  await topUp(tenantId);
  const firstId = await createVolume(tenantId, "first", 52428800);
  const secondId = await createVolume(tenantId, "second", 52428800);

  const results = await Promise.all([
    request(`/tenants/${tenantId}/volumes/${firstId}/resize`, "PATCH", {
      sizeBytes: 104857600,
    }),
    request(`/tenants/${tenantId}/volumes/${secondId}/resize`, "PATCH", {
      sizeBytes: 104857600,
    }),
  ]);

  assertExactlyOneQuotaWinner(results, "concurrent Volume resize");
  const volumes = await prisma.volume.findMany({
    where: { tenantId },
    select: { sizeBytes: true },
  });
  const storage = volumes.reduce((sum, volume) => sum + Number(volume.sizeBytes), 0);
  assert(
    storage <= 157286400,
    `Concurrent Volume resize exceeded storage quota: ${storage} > 157286400`,
  );
}

async function createTenant(kind: string) {
  const result = await request("/tenants", "POST", {
    name: `stage11-${kind}-${suffix}`,
    displayName: `Stage 11 ${kind}`,
    contactEmail: `stage11-${kind}-${suffix}@example.local`,
  });
  expectSuccess(result, `create ${kind} tenant`);
  return stringField(result.payload, "id");
}

async function setQuota(tenantId: string, quota: Record<string, number>) {
  const result = await request(`/tenants/${tenantId}/quota`, "PATCH", quota);
  expectSuccess(result, "set quota");
}

async function topUp(tenantId: string) {
  const result = await request(`/tenants/${tenantId}/billing/top-up`, "POST", {
    amount: 100,
    reference: "stage11 quota concurrency smoke",
  });
  expectSuccess(result, "top up billing");
}

async function createAppGroup(tenantId: string, name: string) {
  const result = await request(`/tenants/${tenantId}/app-groups`, "POST", {
    name,
    runtimeState: "Stopped",
  });
  expectSuccess(result, "create AppGroup");
  return stringField(result.payload, "id");
}

async function createSingleApp(
  tenantId: string,
  appGroupId: string,
  name: string,
  cpu: number,
) {
  const result = await request(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps`,
    "POST",
    {
      name,
      image: "nginx:alpine",
      desiredReplicas: 1,
      runtimeState: "Stopped",
      cpu,
      memoryBytes: 67108864,
    },
  );
  expectSuccess(result, `create SingleApp ${name}`);
  return stringField(result.payload, "id");
}

async function createVolume(tenantId: string, name: string, sizeBytes: number) {
  const result = await request(`/tenants/${tenantId}/volumes`, "POST", {
    name,
    sizeBytes,
  });
  expectSuccess(result, `create Volume ${name}`);
  return stringField(result.payload, "id");
}

async function request(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
  return {
    status: response.status,
    payload: text ? (JSON.parse(text) as unknown) : null,
  };
}

function assertExactlyOneQuotaWinner(results: ApiResult[], label: string) {
  const successes = results.filter((result) => result.status >= 200 && result.status < 300);
  const rejected = results.filter((result) => result.status === 403);

  assert(successes.length === 1, `${label}: expected exactly one success, got ${successes.length}`);
  assert(
    rejected.length === results.length - 1,
    `${label}: expected remaining requests to fail with HTTP 403, got statuses ${results
      .map((result) => result.status)
      .join(", ")}`,
  );
}

function expectSuccess(result: ApiResult, label: string) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} failed: HTTP ${result.status} ${JSON.stringify(result.payload)}`);
  }
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object response with field ${field}`);
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }
  return fieldValue;
}

function assert(condition: boolean, message: string): asserts condition {
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
    await prisma.$disconnect();
  });
