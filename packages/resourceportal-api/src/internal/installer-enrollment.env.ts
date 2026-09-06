import { isAbsolute } from "node:path";
import { loadSecretFiles, SecretFileEnv } from "../config/secret-file-loader";

const requiredValues = [
  "DATABASE_URL",
  "INSTALLER_SWARM_WORKER_TOKEN",
  "INSTALLER_SWARM_MANAGER_TOKEN",
  "INSTALLER_SWARM_MANAGER_ENDPOINT",
  "INSTALLER_STORAGE_SERVER_ADDRESS",
  "INSTALLER_CLUSTER_ID",
  "INSTALLER_VERSION",
  "INSTALLER_SWARM_ADVERTISE_ADDR",
  "INSTALLER_CLUSTER_CIDR",
] as const;

const requiredAbsolutePaths = [
  "INSTALLER_ENROLLMENT_TLS_CERT_FILE",
  "INSTALLER_ENROLLMENT_TLS_KEY_FILE",
] as const;

export function validateInstallerEnrollmentEnv<T extends SecretFileEnv>(env: T): T {
  loadSecretFiles(env);
  const errors: string[] = [];
  for (const key of requiredValues) {
    if (!env[key]) errors.push(`${key} is required`);
  }
  for (const key of requiredAbsolutePaths) {
    const value = env[key];
    if (!value) errors.push(`${key} is required`);
    else if (!isAbsolute(value)) errors.push(`${key} must be an absolute path`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid installer enrollment configuration: ${errors.join("; ")}`);
  }
  return env;
}
