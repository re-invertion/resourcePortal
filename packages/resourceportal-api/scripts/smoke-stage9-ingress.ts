import { NestFactory } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { IngressReconcilerService } from "../src/internal/ingress-reconciler.service";
import { StackRuntimeService } from "../src/internal/stack-runtime.service";
import {
  appGroupNetworkName,
  legacyAppGroupIngressNetworkName,
} from "../src/internal/traefik-routing";
import { WorkerModule } from "../src/worker.module";

const prisma = new PrismaClient();
const apiBaseUrl = (
  process.env.RESOURCE_PORTAL_API_URL ?? "http://localhost:3001/api"
).replace(/\/$/, "");
const dockerContext = process.env.DOCKER_CONTEXT ?? "default";
const resolver = process.env.TRAEFIK_CERT_RESOLVER ?? "smoke-resolver";
const suffix = `${Date.now()}`;

let tenantId: string | undefined;
let appGroupId: string | undefined;
let realTraefikServiceName: string | undefined;

type JsonObject = Record<string, unknown>;

async function main() {
  // This smoke directly modifies a synthetic verified-root fixture and deploys
  // containers. It must never run against a production tenant or database.
  if (
    process.env.STAGE9_ISOLATED_SWARM_FIXTURE !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.NODE_ENV !== "test" ||
    !["127.0.0.1", "localhost", "::1"].includes(new URL(apiBaseUrl).hostname) ||
    !["127.0.0.1", "localhost", "::1"].includes(
      new URL(process.env.DATABASE_URL ?? "postgresql://invalid@invalid/invalid").hostname,
    )
  ) {
    throw new Error("Stage 9 ingress lifecycle smoke requires an explicitly opted-in isolated local test API and database");
  }
  const userId = process.env.SMOKE_USER_ID;
  if (!userId) {
    throw new Error("SMOKE_USER_ID is required");
  }

  const reconcileOperation = await api<JsonObject>(
    "/platform/swarm-cluster/reconcile",
    {
      method: "POST",
      userId,
    },
  );
  await runOperationToTerminal(
    stringField(reconcileOperation, "id"),
    "Succeeded",
  );

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

  await api(`/platform/tenants/${tenantId}/quota`, {
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

  await api("/platform/billing/corrections", {
    method: "POST",
    userId,
    body: { tenantId, amountCredits: "100", reason: "stage9 real swarm smoke" },
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
  const httpEndpoint = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${singleAppId}/http-endpoints`,
    { method: "POST", userId, body: { name: "public-http", containerPort: 80, protocolMode: "HTTP" } },
  );
  const httpEndpointId = stringField(httpEndpoint, "id");
  const customRoot = await api<JsonObject>(
    `/tenants/${tenantId}/domains/custom-root-domains`,
    {
      method: "POST",
      userId,
      body: { rootDomain: "example.test" },
    },
  );
  const customRootDomainId = stringField(customRoot, "id");

  // .test names are intentionally non-resolvable. Mark the root verified
  // exclusively in the disposable CI fixture DB, never in the application
  // service. The domain itself is still created via normal tenant API.
  await prisma.customRootDomain.update({
    where: { id: customRootDomainId },
    data: { verificationStatus: "Verified", verifiedAt: new Date() },
  });
  const subdomain = `stage9-${suffix}`;
  const hostname = `${subdomain}.example.test`;
  const domain = await api<JsonObject>(`/tenants/${tenantId}/domains`, {
    method: "POST",
    userId,
    body: {
      type: "Custom",
      customRootDomainId,
      subdomain,
      httpEndpointId: endpointId,
      tlsEnabled: false,
    },
  });
  const domainId = stringField(domain, "id");
  if (domain.hostname !== hostname) {
    throw new Error("Custom domain hostname did not come from the verified root");
  }
  if (domain.tlsEnabled !== true) {
    throw new Error("HTTPS endpoint must force domain tlsEnabled=true");
  }

  // Real DNS validation is out of scope for the synthetic .test hostname.
  // Seed only its resulting status within the ephemeral Swarm smoke fixture.
  await prisma.domain.update({
    where: { id: domainId },
    data: { dnsStatus: "Valid" },
  });

  // A separate HTTP hostname exercises the actual Traefik Swarm data plane;
  // the original HTTPS fixture continues to cover TLS label construction.
  const httpHostname = `stage9-http-${suffix}.example.test`;
  const httpDomain = await api<JsonObject>(`/tenants/${tenantId}/domains`, {
    method: "POST", userId,
    body: { type: "Custom", customRootDomainId, subdomain: `stage9-http-${suffix}`, httpEndpointId, tlsEnabled: false },
  });
  const httpDomainId = stringField(httpDomain, "id");
  if (httpDomain.hostname !== httpHostname) throw new Error("HTTP fixture hostname differs from verified root");
  await prisma.domain.update({ where: { id: httpDomainId }, data: { dnsStatus: "Valid" } });

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

  await runOperationToTerminal(deploymentId, "Succeeded");
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
  expectLabel(deployedLabels, "traefik.http.routers.nginx-public-http.rule", `Host(\`${httpHostname}\`)`);

  // The CI runner uses a real Traefik process, not the zero-replica anchor
  // used by other Swarm checks. This extra service is never deployed outside
  // the explicit isolated GitHub Actions fixture verified at script startup.
  realTraefikServiceName = `rp-stage9-traefik-${suffix}`;
  const isolatedNetwork = appGroupNetworkName(appGroupId);
  await docker([
    "service", "create", "--name", realTraefikServiceName,
    "--network", isolatedNetwork,
    "--publish", "published=18080,target=80,mode=host",
    "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
    "--constraint", "node.role==manager", "--replicas", "1", "--detach=true",
    // Docker Engine 29 rejects legacy API versions. Keep the provider API
    // compatibility explicit on this disposable smoke service only.
    "--env", "DOCKER_API_VERSION=1.44",
    "traefik:v3.6", "--providers.swarm=true",
    "--providers.swarm.endpoint=unix:///var/run/docker.sock",
    "--providers.swarm.exposedbydefault=false",
    `--providers.swarm.network=${isolatedNetwork}`,
    "--entrypoints.web.address=:80", "--log.level=DEBUG", "--accesslog=true",
  ]);
  await expectReplicas(realTraefikServiceName, 1);
  await expectRealTraefikHttp(httpHostname, 200, "initial running app");

  // Execute real tenant runtime operations against only the disposable Stage 9
  // Swarm service. These are Docker service state/label checks, NOT claims that
  // a Traefik proxy has observed or accepted the router.
  const appGroupRuntimePath = `/tenants/${tenantId}/app-groups/${appGroupId}/runtime`;
  const singleAppRuntimePath = `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${singleAppId}/runtime`;
  await changeRuntime(appGroupRuntimePath, "stop", userId);
  await reconcileIngressOnce();
  await expectReplicas(serviceName, 0);
  assertNoTraefikLabels(await serviceLabels(serviceName), "App Group stopped");
  await expectRealTraefikHttp(httpHostname, 404, "App Group stopped");

  await changeRuntime(appGroupRuntimePath, "start", userId);
  await reconcileIngressOnce();
  await expectReplicas(serviceName, 1);
  expectLabel(await serviceLabels(serviceName), "traefik.http.routers.nginx-public.rule", `Host(\`${hostname}\`)`);
  await expectRealTraefikHttp(httpHostname, 200, "restored running app");

  await changeRuntime(singleAppRuntimePath, "stop", userId);
  await reconcileIngressOnce();
  await expectReplicas(serviceName, 0);
  assertNoTraefikLabels(await serviceLabels(serviceName), "SingleApp stopped");
  await expectRealTraefikHttp(httpHostname, 404, "SingleApp stopped");

  await changeRuntime(singleAppRuntimePath, "start", userId);
  await reconcileIngressOnce();
  await expectReplicas(serviceName, 1);
  expectLabel(await serviceLabels(serviceName), "traefik.http.routers.nginx-public.rule", `Host(\`${hostname}\`)`);
  await expectRealTraefikHttp(httpHostname, 200, "restored running app");

  // A runtime start/stop is not a new deployment revision. Stage9 must
  // exercise a legitimate new desired configuration before redeploying,
  // rather than bypassing the application's "no pending changes" guard.
  await api(
    `/tenants/${tenantId}/app-groups/${appGroupId}/single-apps/${singleAppId}`,
    {
      method: "PATCH",
      userId,
      body: { description: `Stage9 isolated redeploy ${suffix}` },
    },
  );

  const redeployment = await api<JsonObject>(
    `/tenants/${tenantId}/app-groups/${appGroupId}/deploy`,
    {
      method: "POST",
      userId,
      idempotencyKey: `stage9-redeploy-${suffix}`,
      body: { note: "stage9 ingress route real swarm lifecycle redeploy" },
    },
  );
  const redeploymentId = stringField(redeployment, "id");
  await runOperationToTerminal(redeploymentId, "Succeeded");
  await expectDeploymentStatus(userId, redeploymentId, "Succeeded");
  await reconcileIngressOnce();
  await expectReplicas(serviceName, 1);
  expectLabel(await serviceLabels(serviceName), "traefik.http.routers.nginx-public.rule", `Host(\`${hostname}\`)`);
  await expectRealTraefikHttp(httpHostname, 200, "restored running app");

  await api(`/tenants/${tenantId}/domains/${domainId}`, {
    method: "PATCH",
    userId,
    body: { httpEndpointId: null },
  });
  await api(`/tenants/${tenantId}/domains/${httpDomainId}`, {
    method: "PATCH", userId, body: { httpEndpointId: null },
  });

  await reconcileIngressOnce();

  await expectRealTraefikHttp(httpHostname, 404, "both domains detached");
  const cleanedLabels = await serviceLabels(serviceName);
  for (const key of Object.keys(cleanedLabels)) {
    if (key.startsWith("traefik.")) {
      throw new Error(
        `Stale Stage 9 Traefik label remained after detach: ${key}`,
      );
    }
  }

  console.log("Stage 9 real isolated Swarm + actual Traefik HTTP routing lifecycle PASS (running 200, stopped 404, restored 200, detached 404)");
}

async function cleanup() {
  if (realTraefikServiceName) {
    await docker(["service", "rm", realTraefikServiceName], true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await docker(["service", "inspect", realTraefikServiceName], true);
      if (result.exitCode !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (appGroupId) {
    const stackName = stackNameFor(appGroupId);
    await docker(["stack", "rm", stackName], true);
    await waitForStackRemoval(stackName);
  }

  if (tenantId) {
    await prisma.tenant
      .delete({ where: { id: tenantId } })
      .catch(() => undefined);
  }
}

async function reconcileIngressOnce() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  try {
    const reconciler = app.get(IngressReconcilerService);
    const maxAttempts = 4;
    let lastResult:
      { checked: number; changed: number; failed: number } | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await reconciler.reconcileBatch({ appGroupId });
      if (lastResult.failed === 0) {
        return;
      }

      if (attempt < maxAttempts) {
        console.log(
          `Ingress reconciliation attempt ${attempt}/${maxAttempts} reported ${lastResult.failed} transient failure(s); retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    if (!appGroupId) {
      throw new Error(
        "Ingress reconciliation failed before App Group diagnostics were available",
      );
    }

    const runtime = app.get(StackRuntimeService);
    const networkName = appGroupNetworkName(appGroupId);
    const legacyNetworkName = legacyAppGroupIngressNetworkName(appGroupId);
    const serviceName = `${stackNameFor(appGroupId)}_nginx`;
    const diagnostics = {
      appGroupNetwork: await runtime.reconcileAppGroupNetwork({
        networkName,
        traefikRequired: false,
      }),
      tenantNetwork: await runtime.reconcileServiceNetwork({
        serviceName,
        networkName,
        required: true,
      }),
      legacyMembership: await runtime.reconcileServiceNetwork({
        serviceName,
        networkName: legacyNetworkName,
        required: false,
      }),
      labels: await runtime.reconcileTraefikLabels({
        serviceName,
        desiredLabels: {},
      }),
      legacyCleanup: await runtime.reconcileLegacyIngressNetwork({
        networkName: legacyNetworkName,
        required: false,
      }),
    };
    throw new Error(
      `Ingress reconciliation did not converge after ${maxAttempts} attempts: ${JSON.stringify({ lastResult, diagnostics })}`,
    );
  } finally {
    await app.close();
  }
}

async function runOperationToTerminal(
  operationId: string,
  expectedStatus: string,
) {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const operation = await prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        type: true,
        status: true,
        nextAttemptAt: true,
        errorCode: true,
        errorMessage: true,
      },
    });
    if (!operation) {
      throw new Error(`Operation ${operationId} was not found`);
    }

    if (operation.status === expectedStatus) {
      return;
    }
    if (
      operation.status === "Failed" ||
      operation.status === "RollbackFailed" ||
      operation.status === "RolledBack"
    ) {
      throw new Error(
        `Operation ${operationId} (${operation.type}) reached ${operation.status}, expected ${expectedStatus}: ${operation.errorCode ?? "no-code"} ${operation.errorMessage ?? ""}`,
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
      `Expected deployment ${deploymentId} to be ${expectedStatus}, got ${status}: ${diagnosticField(deployment.errorCode, "no-code")} ${diagnosticField(deployment.errorMessage, "")}`,
    );
  }
}

async function changeRuntime(
  resourcePath: string,
  action: "start" | "stop",
  userId: string,
) {
  const result = await api<JsonObject>(`${resourcePath}/${action}`, {
    method: "POST",
    userId,
  });
  await runOperationToTerminal(stringField(result, "operationId"), "Succeeded");
}

async function expectReplicas(serviceName: string, expected: number) {
  const desired = await docker([
    "service", "inspect", serviceName,
    "--format", "{{.Spec.Mode.Replicated.Replicas}}",
  ]);
  if (Number(desired.stdout) !== expected) {
    throw new Error(`Expected disposable Swarm service ${serviceName} desired replicas=${expected}, got ${desired.stdout}`);
  }

  // Docker service updates can complete before tasks converge. Verify the
  // actual observed healthy/running replica count, not only desired state.
  const expectedState = `${expected}/${expected}`;
  let lastObserved = "<not listed>";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const actual = await docker([
      "service", "ls", "--filter", `name=${serviceName}`,
      "--format", "{{.Name}} {{.Replicas}}",
    ]);
    const matching = actual.stdout.split("\n").find((row) =>
      row.startsWith(`${serviceName} `),
    );
    lastObserved = matching?.slice(serviceName.length + 1) ?? "<not listed>";
    if (lastObserved === expectedState) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Disposable Swarm service ${serviceName} never reached observed replicas ${expectedState}; last=${lastObserved}`);
}

function assertNoTraefikLabels(labels: Record<string, string>, state: string) {
  const leaked = Object.keys(labels).filter((key) => key.startsWith("traefik."));
  if (leaked.length > 0) {
    throw new Error(`Stage 9 ${state} still publishes Traefik label keys: ${leaked.join(", ")}`);
  }
}

async function probeLocalTraefik(hostname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port: 18080, path: "/", method: "GET",
      headers: { Host: hostname }, timeout: 2500, agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8").slice(0, 4000),
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("isolated Traefik probe timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function expectRealTraefikHttp(hostname: string, expectedStatus: 200 | 404, stage: string) {
  let observed = "No HTTP response";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      // Use the Node HTTP client directly, bypassing any global Fetch proxy
      // dispatcher/redirect handling on the hosted CI runner. The explicit
      // Host is essential: the synthetic .test name has no public DNS record.
      const response = await probeLocalTraefik(hostname);
      observed = `${response.status} (${response.body.slice(0, 120)})`;
      if (response.status === expectedStatus) {
        if (expectedStatus === 200 && !response.body.includes("Welcome to nginx")) {
          observed = "200 without nginx backend content";
        } else if (expectedStatus === 404 && !response.body.includes("404 page not found")) {
          observed = "404 not generated by Traefik";
        } else {
          console.log(`Real Traefik HTTP route ${hostname}: ${expectedStatus} observed for ${stage}`);
          return;
        }
      }
    } catch (error) {
      observed = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // The runner is disposable. Surface proxy/provider errors on any failure,
  // rather than accepting an unexplained 404 as proof of a missing route.
  const proxyLogs = realTraefikServiceName
    ? await docker(["service", "logs", "--tail", "70", realTraefikServiceName], true)
    : undefined;
  if (proxyLogs) {
    console.error(`Real Traefik disposable service logs (exit=${proxyLogs.exitCode}): ${proxyLogs.stdout.slice(-11000)}`);
  }
  throw new Error(`Real Traefik HTTP ${stage}: expected ${expectedStatus} from ${hostname}, observed ${observed}`);
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

function diagnosticField(value: unknown, fallback: string) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
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
