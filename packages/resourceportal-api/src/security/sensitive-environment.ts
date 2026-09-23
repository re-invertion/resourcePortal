import { EncryptionService } from "./encryption.service";

const SENSITIVE_ENVIRONMENT_NAME =
  /(^|_)(password|passwd|secret|token|api_?key|private_?key|credential)(_|$)/i;
const ENCRYPTED_PREFIX = "enc:v1:";

type DeploymentSnapshot = {
  singleApps?: Array<{
    environment?: Record<string, unknown>;
    variables?: Array<{ targetName?: unknown; value?: unknown }>;
  }>;
};

export function isSensitiveEnvironmentName(name: string) {
  return SENSITIVE_ENVIRONMENT_NAME.test(name);
}

export function protectSensitiveValue(
  name: string,
  value: string,
  encryption: EncryptionService,
) {
  return isSensitiveEnvironmentName(name) && !value.startsWith(ENCRYPTED_PREFIX)
    ? encryption.encrypt(value)
    : value;
}

export function protectSensitiveEnvironment(
  environment: Record<string, string>,
  encryption: EncryptionService,
) {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      protectSensitiveValue(name, value, encryption),
    ]),
  );
}

export function revealSensitiveEnvironment(
  environment: Record<string, string>,
  encryption: EncryptionService,
) {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      isSensitiveEnvironmentName(name) && value.startsWith(ENCRYPTED_PREFIX)
        ? encryption.decrypt(value)
        : value,
    ]),
  );
}

export function protectDeploymentStackConfig(
  serialized: string,
  encryption: EncryptionService,
) {
  const snapshot = JSON.parse(serialized) as DeploymentSnapshot;
  let protectedValues = 0;

  for (const app of snapshot.singleApps ?? []) {
    for (const [name, value] of Object.entries(app.environment ?? {})) {
      if (
        typeof value === "string" &&
        isSensitiveEnvironmentName(name) &&
        !value.startsWith(ENCRYPTED_PREFIX)
      ) {
        app.environment![name] = encryption.encrypt(value);
        protectedValues += 1;
      }
    }
    for (const variable of app.variables ?? []) {
      if (
        typeof variable.targetName === "string" &&
        typeof variable.value === "string" &&
        isSensitiveEnvironmentName(variable.targetName) &&
        !variable.value.startsWith(ENCRYPTED_PREFIX)
      ) {
        variable.value = encryption.encrypt(variable.value);
        protectedValues += 1;
      }
    }
  }

  return {
    stackConfig: protectedValues > 0 ? JSON.stringify(snapshot) : serialized,
    protectedValues,
  };
}

export function hasProtectedSensitiveEnvironment(serialized: string | null) {
  return serialized?.includes(ENCRYPTED_PREFIX) ?? false;
}

export function revealSensitiveValue(
  name: string,
  value: string,
  encryption: EncryptionService,
) {
  return isSensitiveEnvironmentName(name) && value.startsWith(ENCRYPTED_PREFIX)
    ? encryption.decrypt(value)
    : value;
}
