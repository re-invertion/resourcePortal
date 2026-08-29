import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { AppModule } from "../app.module";
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
  deploymentId: string,
  workerId: string,
  leaseSeconds: number,
  heartbeatIntervalMs: number,
  task: () => Promise<T>,
) {
  const interval = setInterval(() => {
    void worker
      .heartbeatDeployment(deploymentId, { workerId, leaseSeconds })
      .catch((error: unknown) => {
        logger.warn(
          `Heartbeat failed for deployment ${deploymentId}: ${errorMessage(error)}`,
        );
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
  initialDeployment: WorkerDeployment,
  workerId: string,
  leaseSeconds: number,
  heartbeatIntervalMs: number,
) {
  let deployment = initialDeployment;
  logger.log(`Processing deployment ${deployment.id}`);

  for (const phase of DEPLOYMENT_PHASES) {
    if (isTerminal(deployment)) {
      logger.log(
        `Deployment ${deployment.id} stopped in ${deployment.status} during ${deployment.phase}`,
      );
      return deployment;
    }

    deployment = await runWithHeartbeat(
      worker,
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

  logger.log(
    `Deployment ${deployment.id} finished with ${deployment.status} at ${deployment.phase}`,
  );

  return deployment;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const config = app.get(ConfigService);
  const worker = app.get(DeploymentWorkerService);
  const workerId = config.get<string>("WORKER_ID") ?? "local-worker";
  const pollIntervalMs = readInt(config, "WORKER_POLL_INTERVAL_MS", 5000);
  const leaseSeconds = readInt(config, "WORKER_LEASE_SECONDS", 300, 15);
  const once = readBool(config, "WORKER_ONCE");
  const heartbeatIntervalMs = Math.max(
    1000,
    Math.floor((leaseSeconds * 1000) / 3),
  );
  let stopping = false;

  const stop = (signal: NodeJS.Signals) => {
    logger.log(`Received ${signal}; stopping after current cycle`);
    stopping = true;
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    logger.log(
      `Deployment worker ${workerId} started (poll=${pollIntervalMs}ms lease=${leaseSeconds}s once=${once})`,
    );

    while (!stopping) {
      const claimed = (await worker.claimNextDeployment({
        workerId,
        leaseSeconds,
      })) as WorkerDeployment | null;

      if (!claimed) {
        if (once) {
          logger.log("No pending deployment found; exiting");
          break;
        }

        await sleep(pollIntervalMs);
        continue;
      }

      try {
        await processDeployment(
          worker,
          claimed,
          workerId,
          leaseSeconds,
          heartbeatIntervalMs,
        );
      } catch (error: unknown) {
        logger.error(
          `Unhandled worker error for deployment ${claimed.id}: ${errorMessage(error)}`,
        );

        await worker
          .failDeployment(claimed.id, {
            workerId,
            errorCode: "WorkerUnhandledError",
            errorMessage: errorMessage(error),
          })
          .catch((failError: unknown) => {
            logger.error(
              `Failed to mark deployment ${claimed.id} as failed: ${errorMessage(failError)}`,
            );
          });
      }

      if (once) {
        break;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await app.close();
  }
}

void main().catch((error: unknown) => {
  logger.error(`Deployment worker crashed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
