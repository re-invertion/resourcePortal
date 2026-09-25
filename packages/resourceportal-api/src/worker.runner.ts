import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DomainCertificateReconcilerService } from "./internal/domain-certificate-reconciler.service";
import { IngressReconcilerService } from "./internal/ingress-reconciler.service";
import { RuntimeDriftReconcilerService } from "./internal/runtime-drift-reconciler.service";
import { NetworkEgressReconcilerService } from "./network-egress/network-egress-reconciler.service";
import { GateRuntimeReconcilerService } from "./networking/gate-runtime-reconciler.service";
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
  const operations = app.get(OperationsWorkerService);
  const artifactSecurity = app.get(DeploymentArtifactSecurityMigrationService);
  const legacySecrets = app.get(LegacySecretMigrationService);
  const certificates = app.get(DomainCertificateReconcilerService);
  const ingress = app.get(IngressReconcilerService);
  const drift = app.get(RuntimeDriftReconcilerService);
  const volumeUsage = app.get(VolumeUsageReconcilerService);
  const egressPolicy = app.get(NetworkEgressReconcilerService);
  const gateRuntime = app.get(GateRuntimeReconcilerService);
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
    gateRuntime: readInt(
      config,
      "GATE_RUNTIME_RECONCILE_INTERVAL_MS",
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
    await app.close();
  }
}

void main().catch((error: unknown) => {
  structuredLog(logger, "error", serviceName, "worker.process_exit_error", {
    error: errorMessage(error),
  });
  process.exitCode = 1;
});
