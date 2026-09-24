type MigrationRunner =
  typeof import("./migrate-penpot-runtime-secrets.runner.js");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runner =
    (await import("./migrate-penpot-runtime-secrets.runner.js")) as MigrationRunner;
  await runner.runPenpotRuntimeSecretMigration(options);
}

function parseArgs(args: string[]) {
  const appGroupIndex = args.indexOf("--app-group-id");
  const appGroupId = appGroupIndex >= 0 ? args[appGroupIndex + 1] : undefined;
  if (!appGroupId || !/^[0-9a-fA-F-]{36}$/.test(appGroupId)) {
    throw new Error(
      "Usage: migrate-penpot-runtime-secrets --app-group-id <uuid> [--apply]",
    );
  }
  return { appGroupId, apply: args.includes("--apply") };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
