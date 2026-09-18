import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

export function prismaPostinstallPrerequisites(root = defaultRoot) {
  const schemaPath = resolve(
    root,
    "packages/resourceportal-api/prisma/schema.prisma",
  );
  const prismaPackagePath = resolve(root, "node_modules/prisma/package.json");
  return existsSync(schemaPath) && existsSync(prismaPackagePath);
}

export function runPrismaPostinstall(root = defaultRoot) {
  if (!prismaPostinstallPrerequisites(root)) {
    console.log(
      "Skipping API Prisma Client generation for a partial workspace install.",
    );
    return 0;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "api:prisma:generate"], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exit(runPrismaPostinstall());
}
