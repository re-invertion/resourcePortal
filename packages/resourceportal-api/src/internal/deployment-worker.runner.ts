import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { createServer } from "node:http";
import { AppModule } from "../app.module";
import { ObservabilityService } from "../observability/observability.service";
import { DeploymentWorkerService } from "./deployment-worker.service";

const logger = new Logger("DeploymentWorkerRunner");

type WorkerDeployment = {
  id: string;
  status: DeploymentStatus;
  phase: DeploymentPhase;
};

const DEPLOYMENT_PHASES = [
  DeploymentPhase.PreparingArtifacts,
  DeploymentPhase.GeneratingStack,
  DeploymentPhase.ApplyingStack,
  DeploymentPhase.WaitingForRollout,
] as const;

function readInt(
  config: ConfigService,
  key: string,
  fallback: number,
  minimum = 1,
) {
  const raw = config.get<string>(key);
  const parsed = raw === undefined ? fallback : Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function readBool(config: ConfigService, key: string) {
  return ["1", "true", "yes", "on"].includes(
    (config.get<string>(key) ?? "").toLowerCase(),
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logWorkerEvent(
  level: "error" | "log" | "warn",
  event: string,
  fields: Record<string, unknown> = {},
) {
  logger[level](
    JSON.stringify({
      event,
      ...fields,
    }),
  );
}

function isTerminal(deployment: WorkerDeployment) {
  return (
    deployment.status === DeploymentStatus.Succeeded ||
    deployment.status === DeploymentStatus.Failed ||
    deployment.status === DeploymentStatus.RolledBack ||
    deployment.status === DeploymentStatus.RollbackFailed
  );
}

async function runWithHeartbeat<T>(
  worker: DeploymentWorkerService,
  metrics: ObservabilityService,
  deploymentId: string,
  workerId: string,
  leaseSeconds: number,
  heartbeatIntervalMs: number,
  task: () => Promise<T>,
) {
  const interval = setInterval(() => {
    void worker
      .heartbeatDeployment(deploymentId, { workerId, leaseSeconds })
      .then(() => metrics.recordWorkerEvent("heartbeat", workerId))
      .catch((error: unknown) => {
        metrics.recordWorkerEvent("heartbeat_failed", workerId);
        logWorkerEvent("warn", "deployment.heartbeat.failed", {
          deploymentId,
          error: errorMessage(error),
          workerId,
        });
      });
  }, heartbeatIntervalMs);

  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
}

async function processDeployment(
  worker: DeploymentWorkerService,
  metrics: ObservabilityService,
  initialDeployment: WorkerDeployment,
  workerId: string,
  leaseSeconds: number,
  heartbeatIntervalMs: number,
) {
  let deployment = initialDeployment;
  logWorkerEvent("log", "deployment.processing.started", {
    deploymentId: deployment.id,
    phase: deployment.phase,
    status: deployment.status,
    workerId,
  });

  for (const phase of DEPLOYMENT_PHASES) {
    if (isTerminal(deployment)) {
      logWorkerEvent("log", "deployment.processing.stopped", {
        deploymentId: deployment.id,
        phase: deployment.phase,
        status: deployment.status,
        workerId,
      });
      return deployment;
    }

    deployment = await runWithHeartbeat(
      worker,
      metrics,
      deployment.id,
      workerId,
      leaseSeconds,
      heartbeatIntervalMs,
      () =>
        worker.advanceDeployment(deployment.id, {
          workerId,
          phase,
          message: `Worker ${workerId} advanced deployment to ${phase}`,
        }),
    );
  }

  logWorkerEvent("log", "deployment.processing.finished", {
    deploymentId: deployment.id,
    phase: deployment.phase,
    status: deployment.status,
    workerId,
  });

  return deployment;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const config = app.get(ConfigService);
  const worker = app.get(DeploymentWorkerService);
  const metrics = app.get(ObservabilityService);
  const workerId = config.get<string>("WORKER_ID") ?? "local-worker";
  const pollIntervalMs = readInt(config, "WORKER_POLL_INTERVAL_MS", 5000);
  const leaseSeconds = readInt(config, "WORKER_LEASE_SECONDS", 300, 15);
  const metricsPort = readInt(config, "WORKER_METRICS_PORT", 9464);
  const once = readBool(config, "WORKER_ONCE");
  const heartbeatIntervalMs = Math.max(
    1000,
    Math.floor((leaseSeconds * 1000) / 3),
  );
  let stopping = false;

  const metricsServer = createServer((request, response) => {
    if (request.url !== "/metrics") {
      response.statusCode = 404;
      response.end("Not Found\n");
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.end(metrics.renderPrometheusMetrics());
  });
  await new Promise<void>((resolve, reject) => {
    metricsServer.once("error", reject);
    metricsServer.listen(metricsPort, "0.0.0.0", () => {
      metricsServer.off("error", reject);
      resolve();
    });
  });

  const stop = (signal: NodeJS.Signals) => {
    logWorkerEvent("log", "worker.stopping", {
      signal,
      workerId,
    });
    metrics.recordWorkerEvent("stopping", workerId);
    stopping = true;
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    metrics.recordWorkerEvent("started", workerId);
    logWorkerEvent("log", "worker.started", {
      leaseSeconds,
      metricsPort,
      once,
      pollIntervalMs,
      workerId,
    });

    while (!stopping) {
      metrics.recordWorkerEvent("poll", workerId);
      const claimed = (await worker.claimNextDeployment({
        workerId,
        leaseSeconds,
      })) as WorkerDeployment | null;

      if (!claimed) {
        metrics.recordWorkerEvent("poll_empty", workerId);
        if (once) {
          logWorkerEvent("log", "worker.no_pending_deployment", { workerId });
          break;
        }

        await sleep(pollIntervalMs);
        continue;
      }

      metrics.recordWorkerEvent("claimed", workerId);
      const startedAt = Date.now();
      try {
        const completed = await processDeployment(
          worker,
          metrics,
          claimed,
          workerId,
          leaseSeconds,
          heartbeatIntervalMs,
        );
        metrics.recordDeploymentOutcome(
          completed.status,
          workerId,
          Date.now() - startedAt,
        );
      } catch (error: unknown) {
        metrics.recordWorkerEvent("processing_error", workerId);
        metrics.recordDeploymentOutcome(
          "WorkerUnhandledError",
          workerId,
          Date.now() - startedAt,
        );
        logWorkerEvent("error", "deployment.processing.error", {
          deploymentId: claimed.id,
          error: errorMessage(error),
          workerId,
        });

        await worker
          .failDeployment(claimed.id, {
            workerId,
            errorCode: "WorkerUnhandledError",
            errorMessage: errorMessage(error),
          })
          .catch((failError: unknown) => {
            metrics.recordWorkerEvent("fail_mark_error", workerId);
            logWorkerEvent("error", "deployment.fail_mark.error", {
              deploymentId: claimed.id,
              error: errorMessage(failError),
              workerId,
            });
          });
      }

      if (once) {
        break;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    await app.close();
  }
}

void main().catch((error: unknown) => {
  logWorkerEvent("error", "worker.crashed", {
    error: errorMessage(error),
  });
  process.exitCode = 1;
});
