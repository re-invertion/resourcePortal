import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { readFileSync } from "node:fs";
import { InstallerEnrollmentModule } from "./installer-enrollment.module";

async function main() {
  const certPath = process.env.INSTALLER_ENROLLMENT_TLS_CERT_FILE;
  const keyPath = process.env.INSTALLER_ENROLLMENT_TLS_KEY_FILE;
  if (!certPath || !keyPath) {
    throw new Error("Installer enrollment TLS certificate and key files are required");
  }

  const adapter = new FastifyAdapter({
    https: {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    InstallerEnrollmentModule,
    adapter,
  );
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );

  const host = process.env.INSTALLER_ENROLLMENT_HOST ?? "0.0.0.0";
  const port = Number.parseInt(process.env.INSTALLER_ENROLLMENT_PORT ?? "7443", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("INSTALLER_ENROLLMENT_PORT must be a valid TCP port");
  }
  await app.listen({ host, port });
  Logger.log(`Installer enrollment listener started on ${host}:${port}`);
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
