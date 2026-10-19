import { Logger } from "@nestjs/common";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DomainCertificateReconcilerService } from "./internal/domain-certificate-reconciler.service";
import { IngressReconcilerService } from "./internal/ingress-reconciler.service";
import { RuntimeDriftReconcilerService } from "./internal/runtime-drift-reconciler.service";
import { NetworkEgressReconcilerService } from "./network-egress/network-egress-reconciler.service";
import { AppLanRouteReconcilerService } from "./networking/app-lan-route-reconciler.service";
import { GateRuntimeReconcilerService } from "./networking/gate-runtime-reconciler.service";
import { DeviceVpnRuntimeReconcilerService } from "./networking/device-vpn-runtime-reconciler.service";
import {
  errorMessage,
  operationCorrelationId,
  structuredLog,
} from "./observability/structured-log";
import {
  WorkerReconcileKey,
  WorkerRuntimeObservabilityService,
} from "./observability/worker-runtime-observability.service";
import { OperationsWorkerService } from "./operations/operations-worker.service";
import { DeploymentArtifactSecurityMigrationService } from "./security/deployment-artifact-security-migration.service";
import { LegacySecretMigrationService } from "./security/legacy-secret-migration.service";
import { VolumeUsageReconcilerService } from "./volumes/volume-usage-reconciler.service";
import { isTransientDatabaseConnectivityError } from "./prisma/database-connectivity";
import { WorkerModule } from "./worker.module";

const logger = new Logger("ResourcePortalWorker");
const serviceName = "resource-portal-worker";

function readInt(
  config: ConfigService,
  key: string,
  fallback: number,
  minimum = 1,
) {
  const raw = config.get<string>(key);
  const parsed = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function readBool(config: ConfigService, key: string) {
  return ["1", "true", "yes", "on"].includes(
    (config.get<string>(key) ?? "").toLowerCase(),
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["error", "warn", "log"],
  });
  const config = app.get(ConfigService);
  // Separate internal-only listener; tenant authorization and service name resolution occur in API.
  // The worker alone holds access to Docker. No published port or ingress route.
  const tokenPath = config.get<string>("INTERNAL_WORKER_TOKEN_FILE");
  const internalToken = tokenPath ? readFileSync(tokenPath, "utf8").trim() : config.get<string>("INTERNAL_WORKER_TOKEN");
  if (!internalToken && process.env.NODE_ENV === "production") throw new Error("Worker log authentication token missing");
  const logsServer = createServer((request, reply) => {
    void (async () => {
    const deny = (status: number) => { reply.writeHead(status); reply.end(); };
    if (request.method !== "POST" || request.url !== "/internal/single-app-logs") return deny(404);
    const supplied = request.headers["x-internal-token"];
    const candidate = typeof supplied === "string" ? supplied : "";
    const correct = Buffer.from(internalToken ?? "");
    const received = Buffer.from(candidate);
    if (!correct.length || received.length !== correct.length || !timingSafeEqual(correct, received)) return deny(403);
    let body = "";
    try {
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1024) return deny(413);
      }
      const payload: unknown = JSON.parse(body);
      const service = payload && typeof payload === "object" && "service" in payload ? payload.service : null;
      if (typeof service !== "string" || !/^rp_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}_[a-zA-Z0-9_]+$/.test(service)) return deny(400);
      const result = await new Promise<{ code: number; output: string }>((resolve) => {
        const child = spawn("docker", ["service", "logs", "--timestamps", "--tail", "100", service], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
        child.stdout.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-65536); });
        child.stderr.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-65536); });
        child.on("error", () => { clearTimeout(timer); resolve({ code: 1, output: "" }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
      });
      if (result.code !== 0) return deny(503);
      reply.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      reply.end(JSON.stringify({ lines: result.output.split("\n").filter(Boolean) }));
    } catch {
      if (!reply.writableEnded) deny(503);
    }
    })();
  });
  if (!readBool(config, "WORKER_ONCE")) await new Promise<void>((resolve, reject) => {
    logsServer.once("error", reject);
    logsServer.listen(3101, "0.0.0.0", () => { logsServer.off("error", reject); resolve(); });
  });
  const operations = app.get(OperationsWorkerService);
  const artifactSecurity = app.get(DeploymentArtifactSecurityMigrationService);
  const legacySecrets = app.get(LegacySecretMigrationService);
  const certificates = app.get(DomainCertificateReconcilerService);
  const ingress = app.get(IngressReconcilerService);
  const drift = app.get(RuntimeDriftReconcilerService);
  const volumeUsage = app.get(VolumeUsageReconcilerService);
  const egressPolicy = app.get(NetworkEgressReconcilerService);
  const gateRuntime = app.get(GateRuntimeReconcilerService);
  const appLanRoutes = app.get(AppLanRouteReconcilerService);
  const deviceVpnRuntime = app.get(DeviceVpnRuntimeReconcilerService);
  const runtimeObservability = app.get(WorkerRuntimeObservabilityService);

  const workerId = config.get<string>("WORKER_ID") ?? `worker-${process.pid}`;
  const pollIntervalMs = readInt(config, "WORKER_POLL_INTERVAL_MS", 5_000);
  const leaseSeconds = readInt(config, "WORKER_LEASE_SECONDS", 300, 15);
  const heartbeatIntervalMs = readInt(
    config,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    10_000,
    1_000,
  );
  const once = readBool(config, "WORKER_ONCE");
  const intervals = {
    certificate: readInt(
      config,
      "DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS",
      60_000,
      5_000,
    ),
    ingress: readInt(config, "INGRESS_RECONCILE_INTERVAL_MS", 15_000, 5_000),
    drift: readInt(config, "DRIFT_SCAN_INTERVAL_MS", 60_000, 5_000),
    volumeUsage: readInt(
      config,
      "VOLUME_USAGE_RECONCILE_INTERVAL_MS",
      60_000,
      5_000,
    ),
    legacySecrets: readInt(
      config,
      "LEGACY_SECRET_MIGRATION_INTERVAL_MS",
      60_000,
      5_000,
    ),
    egressPolicy: readInt(
      config,
      "EGRESS_POLICY_RECONCILE_INTERVAL_MS",
      10_000,
      2_000,
    ),
    appLanRoutes: readInt(
      config, "APP_LAN_ROUTES_RECONCILE_INTERVAL_MS", 10_000, 2_000,
    ),
    gateRuntime: readInt(
      config,
      "GATE_RUNTIME_RECONCILE_INTERVAL_MS",
      10_000,
      2_000,
    ),
    deviceVpnRuntime: readInt(
      config,
      "DEVICE_VPN_RUNTIME_RECONCILE_INTERVAL_MS",
      10_000,
      2_000,
    ),
  };
  const next = {
    certificate: 0,
    ingress: 0,
    drift: 0,
    volumeUsage: 0,
    legacySecrets: 0,
    egressPolicy: 0,
    gateRuntime: 0,
    appLanRoutes: 0,
    deviceVpnRuntime: 0,
  };
  let stopping = false;
  let crashed = false;

  await runtimeObservability.started(workerId);

  const observe = async (task: () => Promise<unknown>, event: string) => {
    try {
      await task();
    } catch (error) {
      structuredLog(logger, "warn", serviceName, event, {
        workerId,
        error: errorMessage(error),
      });
    }
  };

  const heartbeat = setInterval(() => {
    void observe(
      () => runtimeObservability.heartbeat(workerId),
      "worker.heartbeat.persist_failed",
    );
  }, heartbeatIntervalMs);

  const stop = (signal: NodeJS.Signals) => {
    structuredLog(logger, "log", serviceName, "worker.stopping", {
      signal,
      workerId,
    });
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  async function recordReconciliation(
    key: WorkerReconcileKey,
    startedAt: Date,
    success: boolean,
    result?: unknown,
    error?: string,
  ) {
    const completedAt = new Date();
    await observe(
      () =>
        runtimeObservability.reconciliation({
          workerId,
          key,
          startedAt,
          completedAt,
          success,
          result,
          error,
        }),
      "worker.reconciliation.persist_failed",
    );
    return completedAt.getTime() - startedAt.getTime();
  }

  async function reconcile(
    key: WorkerReconcileKey,
    task: () => Promise<unknown>,
  ) {
    if (Date.now() < next[key]) return;
    const startedAt = new Date();
    try {
      const result = await task();
      const durationMs = await recordReconciliation(
        key,
        startedAt,
        true,
        result,
      );
      structuredLog(logger, "log", serviceName, `worker.reconcile.${key}`, {
        result,
        durationMs,
        workerId,
      });
    } catch (error) {
      const failure = errorMessage(error);
      const durationMs = await recordReconciliation(
        key,
        startedAt,
        false,
        undefined,
        failure,
      );
      structuredLog(
        logger,
        "warn",
        serviceName,
        `worker.reconcile.${key}.failed`,
        { error: failure, durationMs, workerId },
      );
    } finally {
      next[key] = Date.now() + intervals[key];
    }
  }

  async function startupReconcile(
    key: WorkerReconcileKey,
    task: () => Promise<unknown>,
  ) {
    const startedAt = new Date();
    try {
      const result = await task();
      const durationMs = await recordReconciliation(
        key,
        startedAt,
        true,
        result,
      );
      structuredLog(
        logger,
        "log",
        serviceName,
        `worker.startup_resync.${key}`,
        { result, durationMs, workerId },
      );
    } catch (error) {
      const failure = errorMessage(error);
      const durationMs = await recordReconciliation(
        key,
        startedAt,
        false,
        undefined,
        failure,
      );
      structuredLog(
        logger,
        "warn",
        serviceName,
        `worker.startup_resync.${key}.failed`,
        { error: failure, durationMs, workerId },
      );
    } finally {
      next[key] = Date.now() + intervals[key];
    }
  }

  try {
    structuredLog(logger, "log", serviceName, "worker.started", {
      workerId,
      leaseSeconds,
      pollIntervalMs,
      heartbeatIntervalMs,
    });

    if (!once) {
      await observe(
        () => artifactSecurity.migrateAll(),
        "worker.startup_artifact_security_migration.failed",
      );
      await startupReconcile("certificate", () =>
        certificates.reconcileBatch(),
      );
      await startupReconcile("ingress", () => ingress.reconcileBatch());
      await startupReconcile("drift", () => drift.reconcileAll());
      await startupReconcile("volumeUsage", () => volumeUsage.reconcileBatch());
      await startupReconcile("legacySecrets", () => legacySecrets.migrateAll());
      await startupReconcile("egressPolicy", () => egressPolicy.reconcile());
      await startupReconcile("gateRuntime", () => gateRuntime.reconcile());
      await startupReconcile("appLanRoutes", () => appLanRoutes.reconcile());
      await startupReconcile("deviceVpnRuntime", () => deviceVpnRuntime.reconcile());
    }

    while (!stopping) {
      await observe(
        () => runtimeObservability.loop(workerId),
        "worker.loop.persist_failed",
      );

      if (!once) {
        await reconcile("certificate", () => certificates.reconcileBatch());
        await reconcile("ingress", () => ingress.reconcileBatch());
        await reconcile("drift", () => drift.reconcileBatch());
        await reconcile("volumeUsage", () => volumeUsage.reconcileBatch());
        await reconcile("legacySecrets", () => legacySecrets.migrateAll());
        await reconcile("egressPolicy", () => egressPolicy.reconcile());
        await reconcile("gateRuntime", () => gateRuntime.reconcile());
        await reconcile("appLanRoutes", () => appLanRoutes.reconcile());
        await reconcile("deviceVpnRuntime", () => deviceVpnRuntime.reconcile());
      }

      let processed;
      try {
        processed = await operations.processNext(workerId, leaseSeconds);
      } catch (error) {
        if (once || !isTransientDatabaseConnectivityError(error)) throw error;
        structuredLog(
          logger,
          "warn",
          serviceName,
          "worker.database_unavailable",
          {
            workerId,
            error: errorMessage(error),
            retryInMs: pollIntervalMs,
          },
        );
        await sleep(pollIntervalMs);
        continue;
      }
      if (!processed) {
        if (once) break;
        await sleep(pollIntervalMs);
        continue;
      }

      await observe(
        () =>
          runtimeObservability.operation(
            workerId,
            processed.id,
            processed.status,
          ),
        "worker.operation.persist_failed",
      );
      structuredLog(logger, "log", serviceName, "worker.operation.processed", {
        operationId: processed.id,
        correlationId: operationCorrelationId(processed.input, processed.id),
        operationType: processed.type,
        status: processed.status,
        attempt: processed.attempt,
        workerId,
      });
      if (once) break;
    }
  } catch (error) {
    crashed = true;
    const failure = errorMessage(error);
    await observe(
      () => runtimeObservability.crashed(workerId, failure),
      "worker.crash.persist_failed",
    );
    structuredLog(logger, "error", serviceName, "worker.crashed", {
      workerId,
      error: failure,
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!crashed) {
      await observe(
        () => runtimeObservability.stopped(workerId),
        "worker.stop.persist_failed",
      );
    }
    await new Promise<void>((resolve) => { if (!logsServer.listening) resolve(); else logsServer.close(() => resolve()); });
    await app.close();
  }
}

void main().catch((error: unknown) => {
  structuredLog(logger, "error", serviceName, "worker.process_exit_error", {
    error: errorMessage(error),
  });
  process.exitCode = 1;
});
