import { loadSecretFiles } from "./secret-file-loader";

type Env = Record<string, string | undefined>;

export function validateWorkerEnv(config: Env) {
  loadSecretFiles(config);
  const errors: string[] = [];
  for (const key of ["DATABASE_URL", "RESOURCE_ENCRYPTION_KEY"]) {
    if (!config[key]) errors.push(`${key} is required`);
  }
  for (const key of [
    "RESOURCE_STORAGE_BASE_PATH",
    "RESOURCE_VOLUME_RUNTIME_ROOT",
    "RESOURCE_SECRET_RUNTIME_ROOT",
    "RESOURCE_PLATFORM_RUNTIME_ROOT",
  ]) {
    const value = config[key];
    if (value && !value.startsWith("/")) {
      errors.push(`${key} must be an absolute path`);
    }
  }
  for (const key of [
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_HEARTBEAT_INTERVAL_MS",
    "WORKER_HEALTH_STALE_SECONDS",
    "WORKER_LEASE_SECONDS",
    "DRIFT_SCAN_INTERVAL_MS",
    "DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS",
    "INGRESS_RECONCILE_INTERVAL_MS",
    "SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS",
    "STORAGE_BACKEND_RECONCILE_INTERVAL_MS",
    "VOLUME_USAGE_RECONCILE_INTERVAL_MS",
    "LEGACY_SECRET_MIGRATION_INTERVAL_MS",
  ]) {
    const value = config[key];
    if (!value) continue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || `${parsed}` !== value.trim()) {
      errors.push(`${key} must be a positive integer`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid worker environment configuration: ${errors.join("; ")}`);
  }
  return config;
}
