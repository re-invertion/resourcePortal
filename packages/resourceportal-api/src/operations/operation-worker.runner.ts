import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { OperationsWorkerService } from "./operations-worker.service";

const logger = new Logger("OperationWorkerRunner");

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
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const config = app.get(ConfigService);
  const worker = app.get(OperationsWorkerService);
  const workerId = config.get<string>("OPERATION_WORKER_ID") ??
    config.get<string>("WORKER_ID") ??
    "local-operation-worker";
  const pollIntervalMs = readInt(
    config,
    "OPERATION_WORKER_POLL_INTERVAL_MS",
    5_000,
  );
  const leaseSeconds = readInt(config, "OPERATION_WORKER_LEASE_SECONDS", 300, 15);
  const once =
    readBool(config, "OPERATION_WORKER_ONCE") || readBool(config, "WORKER_ONCE");
  let stopping = false;

  const stop = (signal: NodeJS.Signals) => {
    logger.log(JSON.stringify({ event: "operation.worker.stopping", signal, workerId }));
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    logger.log(
      JSON.stringify({
        event: "operation.worker.started",
        leaseSeconds,
        once,
        pollIntervalMs,
        workerId,
      }),
    );

    while (!stopping) {
      const processed = await worker.processNext(workerId, leaseSeconds);
      if (!processed) {
        if (once) {
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      logger.log(
        JSON.stringify({
          event: "operation.worker.processed",
          operationId: processed.id,
          status: processed.status,
          workerId,
        }),
      );

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
  logger.error(
    JSON.stringify({
      event: "operation.worker.crashed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
