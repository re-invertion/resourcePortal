import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliAuthMetadata = {
  mode: "device";
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  expiresAt?: string;
  refreshToken?: string;
};

export type CliConfig = {
  apiUrl?: string;
  devUserId?: string;
  token?: string;
  auth?: CliAuthMetadata;
};

export function configPath() {
  return join(homedir(), ".resourceportal", "config.json");
}

export function readConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function clearConfig() {
  const path = configPath();
  if (existsSync(path)) {
    rmSync(path);
  }
}

export async function resolveAuth(
  _apiUrl: string,
): Promise<{ token?: string; devUserId?: string }> {
  if (process.env.RESOURCE_PORTAL_TOKEN) {
    return { token: process.env.RESOURCE_PORTAL_TOKEN };
  }
  if (process.env.RESOURCE_PORTAL_DEV_USER_ID) {
    return { devUserId: process.env.RESOURCE_PORTAL_DEV_USER_ID };
  }

  const config = readConfig();
  if (config.devUserId) {
    return { devUserId: config.devUserId };
  }
  if (config.token) {
    return { token: config.token };
  }
  return {};
}
