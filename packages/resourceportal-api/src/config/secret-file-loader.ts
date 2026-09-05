import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type SecretFileEnv = Record<string, string | undefined>;

export const SECRET_FILE_KEYS = [
  "DATABASE_URL",
  "RESOURCE_ENCRYPTION_KEY",
  "AUTH_COOKIE_SECRET",
  "INTERNAL_WORKER_TOKEN",
  "OIDC_CLIENT_SECRET",
  "ZITADEL_MANAGEMENT_TOKEN",
  "ZITADEL_BOOTSTRAP_PAT",
  "SMTP_PASSWORD",
  "INSTALLER_SWARM_WORKER_TOKEN",
  "INSTALLER_SWARM_MANAGER_TOKEN",
] as const;

export function loadSecretFiles<T extends SecretFileEnv>(env: T): T {
  const mutableEnv: SecretFileEnv = env;
  for (const key of SECRET_FILE_KEYS) {
    if (mutableEnv[key] !== undefined) continue;
    const fileKey = `${key}_FILE`;
    const path = mutableEnv[fileKey];
    if (!path) continue;
    if (!isAbsolute(path)) {
      throw new Error(`${fileKey} must be an absolute path`);
    }
    try {
      mutableEnv[key] = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new Error(`Unable to read ${fileKey}`);
    }
  }
  return env;
}
