type Env = Record<string, string | undefined>;

const supportedAuthModes = new Set(["dev", "oidc", "zitadel"]);
const defaultInternalWorkerToken = "dev-worker-token";
const traefikResolverPattern = /^[A-Za-z0-9_-]+$/;

export function validateEnv(config: Env) {
  const errors: string[] = [];
  const nodeEnv = config.NODE_ENV ?? "development";
  const authMode = (config.AUTH_MODE ?? "dev").toLowerCase();

  requireValue(config, errors, "DATABASE_URL");

  if (!supportedAuthModes.has(authMode)) {
    errors.push("AUTH_MODE must be one of: dev, oidc, zitadel");
  }

  if (authMode === "oidc" || authMode === "zitadel") {
    requireValue(config, errors, "OIDC_ISSUER_URL");
    requireValue(config, errors, "OIDC_CLIENT_ID");
    requireValue(config, errors, "OIDC_AUDIENCE");
    requireMinLength(config, errors, "AUTH_COOKIE_SECRET", 20);
  }

  requirePositiveIntegerIfSet(config, errors, "AUTH_SESSION_TTL_SECONDS");
  requirePositiveIntegerIfSet(config, errors, "AUTH_SESSION_IDLE_TIMEOUT_SECONDS");
  requirePositiveIntegerIfSet(config, errors, "API_RATE_LIMIT_MAX");
  requirePositiveIntegerIfSet(config, errors, "API_RATE_LIMIT_WINDOW_SECONDS");
  requirePositiveIntegerIfSet(config, errors, "TRAEFIK_TLS_OBSERVE_TIMEOUT_MS");
  requirePositiveIntegerIfSet(
    config,
    errors,
    "DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS",
  );
  requirePositiveIntegerIfSet(config, errors, "INGRESS_RECONCILE_INTERVAL_MS");
  requirePositiveIntegerIfSet(
    config,
    errors,
    "SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS",
  );
  requirePositiveIntegerIfSet(
    config,
    errors,
    "STORAGE_BACKEND_RECONCILE_INTERVAL_MS",
  );
  requirePositiveIntegerIfSet(
    config,
    errors,
    "STORAGE_REMOTE_VALIDATION_TIMEOUT_MS",
  );
  for (const key of [
    "RESOURCE_STORAGE_BASE_PATH",
    "RESOURCE_VOLUME_RUNTIME_ROOT",
    "RESOURCE_SECRET_RUNTIME_ROOT",
    "RESOURCE_PLATFORM_RUNTIME_ROOT",
  ]) {
    requireAbsolutePathIfSet(config, errors, key);
  }
  requirePatternIfSet(
    config,
    errors,
    "TRAEFIK_CERT_RESOLVER",
    traefikResolverPattern,
    "TRAEFIK_CERT_RESOLVER must contain only letters, numbers, underscore, or hyphen",
  );

  if (nodeEnv === "production") {
    if (config.AUTH_COOKIE_SECURE !== "true") {
      errors.push("AUTH_COOKIE_SECURE must be true in production");
    }

    requireValue(config, errors, "RESOURCE_ENCRYPTION_KEY");

    if (
      (config.INTERNAL_WORKER_TOKEN ?? defaultInternalWorkerToken) ===
      defaultInternalWorkerToken
    ) {
      errors.push("INTERNAL_WORKER_TOKEN must be changed in production");
    }

  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration: ${errors.join("; ")}`);
  }

  return config;
}

function requireValue(config: Env, errors: string[], key: string) {
  if (!config[key]) {
    errors.push(`${key} is required`);
  }
}

function requireMinLength(
  config: Env,
  errors: string[],
  key: string,
  minLength: number,
) {
  const value = config[key];

  if (!value) {
    errors.push(`${key} is required`);
    return;
  }

  if (value.length < minLength) {
    errors.push(`${key} must be at least ${minLength} characters`);
  }
}

function requirePositiveIntegerIfSet(
  config: Env,
  errors: string[],
  key: string,
) {
  const value = config[key];

  if (!value) {
    return;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0 || `${parsed}` !== value.trim()) {
    errors.push(`${key} must be a positive integer`);
  }
}

function requirePatternIfSet(
  config: Env,
  errors: string[],
  key: string,
  pattern: RegExp,
  message: string,
) {
  const value = config[key];

  if (value && !pattern.test(value)) {
    errors.push(message);
  }
}

function requireAbsolutePathIfSet(config: Env, errors: string[], key: string) {
  const value = config[key];
  if (value && !value.startsWith("/")) {
    errors.push(`${key} must be an absolute path`);
  }
}
