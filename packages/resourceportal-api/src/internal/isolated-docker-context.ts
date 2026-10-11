import { cp, lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Preserve a configured Docker CLI context without importing ~/.docker/config.json
 * (which contains global registry auth entries). Called on a 0700 temp directory.
 */
export async function copyDockerContextWithoutRegistryCredentials(
  temporaryDockerConfigPath: string,
  contextName: string | undefined,
): Promise<void> {
  if (!contextName || contextName === "default") return;
  const sourceConfig = process.env.DOCKER_CONFIG ||
    join(process.env.HOME || "/root", ".docker");
  // No fallback to the worker's global config.json or credential helpers.
  // Docker named contexts live in contexts/meta and contexts/tls.
  await cp(join(sourceConfig, "contexts"), join(temporaryDockerConfigPath, "contexts"), {
    recursive: true,
    filter: async (path) => !(await lstat(path)).isSymbolicLink(),
  });
}
