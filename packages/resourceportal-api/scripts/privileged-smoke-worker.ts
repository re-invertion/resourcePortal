const WORKER_ENV_EXACT_KEYS = new Set([
  "NODE_ENV",
  "DATABASE_URL",
  "AUTH_MODE",
  "RESOURCE_ENCRYPTION_KEY",
]);

const WORKER_ENV_PREFIXES = [
  "RESOURCE_",
  "RESOURCEPORTAL_",
  "STORAGE_",
  "NFS_",
  "TRAEFIK_",
  "DOCKER_",
  "WORKER_",
  "SWARM_",
  "DOMAIN_",
  "INGRESS_",
  "VOLUME_",
  "LEGACY_",
  "PLATFORM_",
  "NETWORK_",
  "INTERNAL_WORKER_",
  "GPU_",
  "GATE_",
  "VPN_",
  "LAN_",
] as const;

function isWorkerEnvironmentKey(key: string) {
  return (
    WORKER_ENV_EXACT_KEYS.has(key) ||
    WORKER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function privilegedSmokeCommandArgs(
  workerEnv: NodeJS.ProcessEnv,
  commandName: string,
  commandArgs: string[],
) {
  const assignments = Object.entries(workerEnv)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && isWorkerEnvironmentKey(entry[0]),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);

  return ["/usr/bin/env", ...assignments, commandName, ...commandArgs];
}

export function privilegedSmokeWorkerArgs(
  workerEnv: NodeJS.ProcessEnv,
  nodeExecPath: string,
  npmExecPath: string,
) {
  return privilegedSmokeCommandArgs(workerEnv, nodeExecPath, [
    npmExecPath,
    "run",
    "worker",
  ]);
}
