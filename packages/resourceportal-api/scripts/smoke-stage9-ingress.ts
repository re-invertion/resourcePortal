import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";

const prisma = new PrismaClient();
const apiBaseUrl = (process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3001/api").replace(/\/$/, "");
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const resolver = process.env.TRAEFIK_CERT_RESOLVER ?? "smoke-resolver";
const managedBase = process.env.MANAGED_DOMAIN_BASE ?? "apps.resource-portal.local";
const suffix = `${Date.now()}`;

let tenantId: string | undefined;
let appGroupId: string | undefined;

type JsonObject = Record<string, unknown>;

async function main() {
  const userId = process.env.SMOKE_USER_ID;
  if (!userId) {
    throw new Error("SMOKE_USER_ID is required");
  }

  const tenant = await api<JsonObject>("/tenants", {
    method: "POST",
    userId,
    body: {
      name: `stage9-${suffix}`,
      displayName: "Stage 9 Swarm Smoke",
      contactEmail: `stage9-${suffix}@example.com`,
    },
  });
  tenantId = stringField(tenant, "id");

  await api(`/tenants/${tenantId}/quota`, {
    method: "PATCH",
    userId,
    body: {
      cpu: 2,
      memoryBytes: 536870912,
      gpu: 0,
      storageBytes: 1073741824,
      maxSingleApps: 5,
      maxVolumes: 5,
    },
  });

  await api(`/tenants/${tenantId}/billing/top-up`, {
    method: "POST",
    userId,
    body: { amount: 100, reference: "stage9 real swarm smoke" },
  });

  const appGroup = await api<JsonObject>(`/tenants/${tenantId}/app-groups`, {
    method: "POST",
    userId,
    body: { name: "stage9", runtimeState: "Running" },
  });
  appGroupId = stringField(appGroup, "id");

  const singleApp = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps`,
    {
      method: "POST",
      userId,
      body: {
        name: "nginx",
        image: "nginx:alpine",
        desiredReplicas: 1,
        runtimeState: "Running",
        cpu: 0.1,
        memoryBytes: 134217728,
      },
    },
  );
  const singleAppId = stringField(singleApp, "id");

  const endpoint = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${singleAppId}/http-endpoints`,
    {
      method: "POST",
      userId,
      body: {
        name: "public",
        containerPort: 80,
        protocolMode: "HTTPS",
      },
    },
  );
  const endpointId = stringField(endpoint, "id");
  const prefix = `stage9-${suffix}`;
  const hostname = `${prefix}.${managedBase}`;

  const domain = await api<JsonObject>(`/tenants/${tenantId}/domains`, {
    method: "POST",
    userId,
    body: {
      type: "Managed",
      prefix,
      httpEndpointId: endpointId,
      tlsEnabled: false,
    },
  });
  const domainId = stringField(domain, "id");
  if (domain.tlsEnabled !== true) {
    throw new Error("HTTPS endpoint must force domain tlsEnabled=true");
  }

  const deployment = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deploy`,
    {
      method: "POST",
      userId,
      idempotencyKey: `stage9-deploy-${suffix}`,
      body: { note: "stage9 ingress tls smoke" },
    },
  );
  const deploymentId = stringField(deployment, "id");

  await runWorkerOnce();
  await expectDeploymentStatus(userId, deploymentId, "Succeeded");

  const serviceName = `${stackNameFor(appGroupId)}_nginx`;
  const deployedLabels = await serviceLabels(serviceName);
  expectLabel(
    deployedLabels,
    "traefik.http.routers.nginx-public.rule",
    `Host(\`${hostname}\`)`,
  );
  expectLabel(deployedLabels, "traefik.http.routers.nginx-public.tls", "true");
  expectLabel(
    deployedLabels,
    "traefik.http.routers.nginx-public.tls.certresolver",
    resolver,
  );
  expectLabel(
    deployedLabels,
    "traefik.http.services.nginx-public.loadbalancer.server.port",
    "80",
  );

  await api(`/tenants/${tenantId}/domains/${domainId}`, {
    method: "PATCH",
    userId,
    body: { httpEndpointId: null },
  });

  await runWorkerOnce();

  const cleanedLabels = await serviceLabels(serviceName);
  for (const key of Object.keys(cleanedLabels)) {
    if (key.startsWith("traefik.http.routers.nginx-public")) {
      throw new Error(`Stale Stage 9 router label remained after detach: ${key}`);
    }
  }
  expectLabel(
    cleanedLabels,
    "traefik.http.services.nginx-public.loadbalancer.server.port",
    "80",
  );

  console.log("Stage 9 ingress/TLS real Swarm smoke completed successfully");
}

async function cleanup() {
  if (appGroupId) {
    const stackName = stackNameFor(appGroupId);
    await docker(["stack", "rm", stackName], true);
    await waitForStackRemoval(stackName);
  }

  if (tenantId) {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
}

async function runWorkerOnce() {
  const result = await command("npm", ["run", "worker:deployments"], {
    ...process.env,
    WORKER_ONCE: "true",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Deployment worker failed");
  }
}

async function expectDeploymentStatus(
  userId: string,
  deploymentId: string,
  expectedStatus: string,
) {
  const deployment = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deployments/${deploymentId}`,
    { method: "GET", userId },
  );
  const status = stringField(deployment, "status");
  if (status !== expectedStatus) {
    throw new Error(
      `Expected deployment ${deploymentId} to be ${expectedStatus}, got ${status}`,
    );
  }
}

async function serviceLabels(serviceName: string) {
  const result = await docker([
    "service",
    "inspect",
    serviceName,
    "--format",
    "{{json .Spec.Labels}}",
  ]);
  const parsed = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function expectLabel(
  labels: Record<string, string>,
  key: string,
  expected: string,
) {
  if (labels[key] !== expected) {
    throw new Error(
      `Expected service label ${key}=${expected}, got ${labels[key] ?? "<missing>"}`,
    );
  }
}

async function api<T = unknown>(
  path: string,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    userId: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method,
    headers: {
      "x-dev-user-id": options.userId,
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
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
        });
      });
    },
  );
}

async function waitForStackRemoval(stackName: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await docker(
      ["stack", "services", stackName, "--format", "{{.Name}}"],
      true,
    );
    if (!result.stdout) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function stackNameFor(id: string) {
  return `rp_${id.replaceAll("-", "_")}`;
}

function stringField(value: JsonObject, field: string) {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`Expected response field ${field} to be a string`);
  }
  return fieldValue;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
