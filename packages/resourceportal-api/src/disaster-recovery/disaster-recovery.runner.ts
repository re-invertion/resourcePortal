import { NestFactory } from "@nestjs/core";
import { DisasterRecoveryModule } from "./disaster-recovery.module";
import { DisasterRecoveryService } from "./disaster-recovery.service";

async function main() {
  const app = await NestFactory.createApplicationContext(DisasterRecoveryModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const service = app.get(DisasterRecoveryService);
    const result = await service.reconcileAfterRestore();
    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (!result.healthy) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
