import { loadSecretFiles } from "./secret-file-loader";

type Env = Record<string, string | undefined>;

const supportedAuthModes = new Set(["dev", "oidc", "zitadel"]);
const defaultInternalWorkerToken = "dev-worker-token";
const traefikResolverPattern = /^[A-Za-z0-9_-]+$/;

export function validateEnv(config: Env) {
  loadSecretFiles(config);
  const errors: string[] = [];
  const nodeEnv = (config.NODE_ENV ?? "development").trim().toLowerCase();
  const authMode = (config.AUTH_MODE ?? "dev").trim().toLowerCase();

  requireValue(config, errors, "DATABASE_URL");

  if (config.RP_INVITATION_ONBOARDING_ENABLED === "true") {
    requireValue(config, errors, "OIDC_INVITATION_CLIENT_ID");
    requireMinLength(config, errors, "OIDC_INVITATION_CLIENT_SECRET", 24);
    requireValue(config, errors, "OIDC_INVITATION_REDIRECT_URI");
    if (config.OIDC_INVITATION_CLIENT_ID === config.OIDC_CLIENT_ID ||
        config.OIDC_INVITATION_CLIENT_ID === config.OIDC_CLI_CLIENT_ID) {
      errors.push("Invitation identity client must be physically distinct from RP Web and CLI");
    }
    let validRedirect = false;
    try {
      const callback = new URL(config.OIDC_INVITATION_REDIRECT_URI ?? "");
      const publicApi = new URL(config.PUBLIC_API_URL ?? "");
      validRedirect = callback.protocol === "https:" && publicApi.protocol === "https:" &&
        callback.origin === publicApi.origin && !callback.search && !callback.hash &&
        !callback.username && !callback.password &&
        callback.pathname === "/api/invitations/onboard/callback";
    } catch { /* Fail closed for absent/malformed callback or public API URL. */ }
    if (!validRedirect) errors.push("Invitation OIDC callback must match public HTTPS RP API origin");
  }
  if (config.RP_APP_CONSUMER_ACTIONS_V2_ENABLED === "true" &&
      config.RP_INVITATION_ONBOARDING_ENABLED !== "true") {
    errors.push("Global exact-client Action requires a dedicated first-login invitation client");
  }
  if (config.RP_APP_CONSUMER_ACTIONS_V2_ENABLED === "true") {
    if (config.RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED !== "true") {
      errors.push("App Consumer Actions V2 requires explicit isolated HTTPS certification");
    }
    requireMinLength(config, errors, "RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY", 32);
    requireValue(config, errors, "RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID");
    requireValue(config, errors, "RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL");
    requireValue(config, errors, "ZITADEL_MANAGEMENT_TOKEN");
    requireValue(config, errors, "ZITADEL_ORGANIZATION_ID");
    requireValue(config, errors, "OIDC_ISSUER_URL");
    if (config.RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID &&
        !/^[0-9]{1,64}$/.test(config.RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID)) {
      errors.push("RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID must be a ZITADEL target ID");
    }
    if (config.RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL) {
      let safe = false;
      try {
        const url = new URL(config.RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL);
        safe = url.protocol === "https:" && Boolean(url.hostname) &&
          !url.username && !url.password && !url.search && !url.hash &&
          url.pathname === "/api/app-consumer-actions/preaccesstoken";
      } catch { /* Missing or malformed callback cannot authorize App Users. */ }
      if (!safe) errors.push("RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL must be the exact secure callback URL");
    }
  }

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
  requirePositiveIntegerIfSet(config, errors, "API_TRUST_PROXY_HOPS");
  requirePositiveIntegerIfSet(config, errors, "WORKER_HEALTH_STALE_SECONDS");
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
    if (authMode === "dev") {
      errors.push("AUTH_MODE=dev is not allowed in production");
    }

    if (config.AUTH_COOKIE_SECURE !== "true") {
      errors.push("AUTH_COOKIE_SECURE must be true in production");
    }

    if ((config.API_TRUST_PROXY_HOPS ?? "1").trim() !== "1") {
      errors.push("API_TRUST_PROXY_HOPS must be exactly 1 in production");
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
