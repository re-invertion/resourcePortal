import { ResourcePortalClient } from "@resource-portal/sdk";
import { spawn } from "node:child_process";
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

type CliAuthConfigResponse = {
  issuer: string;
  clientId: string;
  scopes: string[];
};

type OidcDiscoveryResponse = {
  issuer?: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type DeviceTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
};

export type InteractiveLoginRuntime = {
  sleep: (milliseconds: number) => Promise<void>;
  openBrowser: (url: string) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
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

export async function manualTokenLogin(apiUrl: string, token: string): Promise<CliConfig> {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const candidate = token.trim();
  if (!candidate) {
    throw new Error("Token is required");
  }

  await validateResourcePortalToken(normalizedApiUrl, candidate);
  const config: CliConfig = { apiUrl: normalizedApiUrl, token: candidate };
  writeConfig(config);
  return config;
}

export async function interactiveLogin(
  apiUrl: string,
  overrides: Partial<InteractiveLoginRuntime> = {},
): Promise<CliConfig> {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const runtime = runtimeWithDefaults(overrides);
  const cliConfig = await fetchCliAuthConfig(normalizedApiUrl);
  const discovery = await fetchOidcDiscovery(cliConfig.issuer);
  const device = await requestDeviceAuthorization(discovery, cliConfig);

  runtime.log(`Open: ${device.verification_uri}`);
  runtime.log(`Code: ${device.user_code}`);
  const browserUrl = device.verification_uri_complete ?? device.verification_uri;
  try {
    await runtime.openBrowser(browserUrl);
  } catch {
    runtime.warn("Could not open browser automatically. Open the URL above and enter the displayed code.");
  }

  const token = await pollDeviceToken(discovery, cliConfig, device, runtime);
  await validateResourcePortalToken(normalizedApiUrl, token.access_token);

  const expiresAt =
    token.expires_in === undefined
      ? undefined
      : new Date(runtime.now() + token.expires_in * 1000).toISOString();
  const config: CliConfig = {
    apiUrl: normalizedApiUrl,
    token: token.access_token,
    auth: {
      mode: "device",
      issuer: cliConfig.issuer,
      clientId: cliConfig.clientId,
      tokenEndpoint: discovery.tokenEndpoint,
      ...(discovery.revocationEndpoint
        ? { revocationEndpoint: discovery.revocationEndpoint }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    },
  };
  writeConfig(config);
  return config;
}

function normalizeApiUrl(apiUrl: string) {
  const value = apiUrl.trim().replace(/\/+$/, "");
  if (!value) {
    throw new Error("API URL is required");
  }
  return value;
}

async function fetchCliAuthConfig(apiUrl: string): Promise<CliAuthConfigResponse> {
  const response = await fetch(`${apiUrl}/auth/cli-config`);
  const payload = await responseJson(response, "Resource Portal CLI authentication configuration is invalid");
  if (!response.ok) {
    throw new Error(`Resource Portal CLI authentication is unavailable (HTTP ${response.status})`);
  }
  if (!isRecord(payload)) {
    throw new Error("Resource Portal CLI authentication configuration is invalid");
  }
  const issuer = nonEmptyString(payload.issuer);
  const clientId = nonEmptyString(payload.clientId);
  const rawScopes = payload.scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : [];
  if (!issuer || !clientId || scopes.length === 0 || !Array.isArray(rawScopes) || scopes.length !== rawScopes.length) {
    throw new Error("Resource Portal CLI authentication configuration is invalid");
  }
  return { issuer: issuer.replace(/\/+$/, ""), clientId, scopes };
}

async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscoveryResponse> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  const payload = await responseJson(response, "OIDC discovery document is invalid");
  if (!response.ok || !isRecord(payload)) {
    throw new Error("OIDC discovery document is unavailable");
  }
  const discoveredIssuer = nonEmptyString(payload.issuer);
  if (discoveredIssuer && discoveredIssuer.replace(/\/+$/, "") !== issuer) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  const deviceAuthorizationEndpoint = nonEmptyString(payload.device_authorization_endpoint);
  const tokenEndpoint = nonEmptyString(payload.token_endpoint);
  if (!deviceAuthorizationEndpoint || !tokenEndpoint) {
    throw new Error("OIDC provider does not support Device Authorization");
  }
  const revocationEndpoint = nonEmptyString(payload.revocation_endpoint);
  return {
    issuer: discoveredIssuer,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  };
}

async function requestDeviceAuthorization(
  discovery: OidcDiscoveryResponse,
  cliConfig: CliAuthConfigResponse,
): Promise<DeviceAuthorizationResponse> {
  const response = await fetch(discovery.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cliConfig.clientId,
      scope: cliConfig.scopes.join(" "),
    }),
  });
  const payload = await responseJson(response, "Device authorization response is malformed");
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`Device authorization request failed (HTTP ${response.status})`);
  }

  const deviceCode = nonEmptyString(payload.device_code);
  const userCode = nonEmptyString(payload.user_code);
  const verificationUri = nonEmptyString(payload.verification_uri);
  const verificationUriComplete = nonEmptyString(payload.verification_uri_complete);
  const expiresIn = positiveNumber(payload.expires_in);
  const interval = nonNegativeNumber(payload.interval);
  if (!deviceCode || !userCode || !verificationUri || expiresIn === undefined) {
    throw new Error("Device authorization response is malformed");
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    ...(verificationUriComplete ? { verification_uri_complete: verificationUriComplete } : {}),
    expires_in: expiresIn,
    ...(interval !== undefined ? { interval } : {}),
  };
}

async function pollDeviceToken(
  discovery: OidcDiscoveryResponse,
  cliConfig: CliAuthConfigResponse,
  device: DeviceAuthorizationResponse,
  runtime: InteractiveLoginRuntime,
): Promise<DeviceTokenResponse> {
  const deadline = runtime.now() + device.expires_in * 1000;
  let intervalMs = (device.interval ?? 5) * 1000;

  while (runtime.now() < deadline) {
    await runtime.sleep(intervalMs);
    if (runtime.now() >= deadline) {
      break;
    }
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: cliConfig.clientId,
      }),
    });
    const payload = await responseJson(response, "OIDC token endpoint returned malformed data");

    if (response.ok) {
      return parseDeviceToken(payload);
    }
    const error = isRecord(payload) ? nonEmptyString(payload.error) : undefined;
    switch (error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new Error("Login denied by user");
      case "expired_token":
        throw new Error("Device login expired. Run rp login again.");
      default:
        throw new Error(error ? `Device login failed: ${error}` : "OIDC token endpoint returned malformed data");
    }
  }

  throw new Error("Device login expired. Run rp login again.");
}

function parseDeviceToken(payload: unknown): DeviceTokenResponse {
  if (!isRecord(payload)) {
    throw new Error("OIDC token endpoint returned malformed data");
  }
  const accessToken = nonEmptyString(payload.access_token);
  const tokenType = nonEmptyString(payload.token_type);
  const expiresIn = positiveNumber(payload.expires_in);
  const refreshToken = nonEmptyString(payload.refresh_token);
  if (!accessToken || !tokenType) {
    throw new Error("OIDC token endpoint returned malformed data");
  }
  return {
    access_token: accessToken,
    token_type: tokenType,
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

async function validateResourcePortalToken(apiUrl: string, token: string) {
  const client = new ResourcePortalClient({ apiUrl, token });
  await client.account.me();
}

function runtimeWithDefaults(
  overrides: Partial<InteractiveLoginRuntime>,
): InteractiveLoginRuntime {
  return {
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    openBrowser: launchBrowser,
    now: () => Date.now(),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    ...overrides,
  };
}

function launchBrowser(url: string): Promise<void> {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function responseJson(response: Response, errorMessage: string): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(errorMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
