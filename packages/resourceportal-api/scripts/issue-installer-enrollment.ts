import { ConfigService } from "@nestjs/config";
import { chmodSync, writeFileSync } from "node:fs";
import { InstallerEnrollmentService } from "../src/internal/installer-enrollment.service";
import { PrismaService } from "../src/prisma/prisma.service";

async function main() {
  const role = process.env.INSTALLER_ENROLLMENT_ROLE;
  const output = process.env.INSTALLER_ENROLLMENT_OUTPUT_FILE;
  if ((role !== "worker" && role !== "manager") || !output) {
    throw new Error("INSTALLER_ENROLLMENT_ROLE and INSTALLER_ENROLLMENT_OUTPUT_FILE are required");
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new InstallerEnrollmentService(
      prisma,
      { get: () => undefined } as unknown as ConfigService,
    );
    const issued = await service.issue(role);
    writeFileSync(
      output,
      `${JSON.stringify({ token: issued.token, role: issued.role, expiresAt: issued.expiresAt.toISOString() })}\n`,
      { mode: 0o600 },
    );
    for (const [suffix, value] of [
      ["token", issued.token],
      ["role", issued.role],
      ["expires-at", issued.expiresAt.toISOString()],
    ] as const) {
      const sidecar = `${output}.${suffix}`;
      writeFileSync(sidecar, `${value}\n`, { mode: 0o600 });
      chmodSync(sidecar, 0o600);
    }
    chmodSync(output, 0o600);
    console.log("Installer enrollment token issued");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
