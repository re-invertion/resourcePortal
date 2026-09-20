import { parseDocument } from "yaml";

export const APP_GROUP_MANIFEST_API_VERSION = "resourceportal.io/v1alpha1";
export const APP_GROUP_MANIFEST_KIND = "AppGroup";
export const APP_GROUP_MANIFEST_MAX_BYTES = 512 * 1024;

export type ManifestIssue = {
  path: string;
  code: string;
  message: string;
};

export type AppGroupManifest = {
  apiVersion: typeof APP_GROUP_MANIFEST_API_VERSION;
  kind: typeof APP_GROUP_MANIFEST_KIND;
  metadata: {
    name: string;
    description?: string;
  };
  spec: {
    runtimeState: "Running" | "Stopped";
    variables: Array<{ name: string; description?: string; value: string }>;
    secrets: Array<{
      name: string;
      description?: string;
      type: "Text" | "Binary";
      fileName?: string;
      value: string;
    }>;
    configs: Array<{ name: string; description?: string; content: string }>;
    apps: Array<{
      name: string;
      description?: string;
      image: string;
      registry?: string;
      desiredReplicas: number;
      runtimeState: "Running" | "Stopped";
      resources: { cpu: number; memoryBytes: number; gpu: number };
      environment: Record<string, string>;
      healthCheck?: Record<string, unknown>;
      entrypoint?: string;
      command: string[];
      workingDir?: string;
      user?: string;
      readOnlyRootFilesystem: boolean;
      stopGracePeriodSeconds: number;
      restartPolicy?: Record<string, unknown>;
      updatePolicy?: Record<string, unknown>;
      variables: Array<{ source: string; targetName: string }>;
      secrets: Array<{ source: string; targetName: string }>;
      configs: Array<{ source: string; targetPath: string }>;
      volumes: Array<{ source: string; mountPath: string; mode: "ReadOnly" | "ReadWrite" }>;
      httpEndpoints: Array<{
        name: string;
        containerPort: number;
        protocolMode: "HTTP" | "HTTPS" | "HTTP_AND_HTTPS" | "HTTP_REDIRECT_TO_HTTPS";
        domains: string[];
      }>;
    }>;
  };
};

type Dict = Record<string, unknown>;

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const runtimeConfigNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretNamePattern = /^(?!\.$)(?!.*\.\.)[A-Za-z0-9_.-]{1,128}$/;
const endpointProtocols = new Set(["HTTP", "HTTPS", "HTTP_AND_HTTPS", "HTTP_REDIRECT_TO_HTTPS"]);
const runtimeStates = new Set(["Running", "Stopped"]);
const attachmentModes = new Set(["ReadOnly", "ReadWrite"]);

export function parseAppGroupManifest(source: string): { manifest?: AppGroupManifest; errors: ManifestIssue[] } {
  const errors: ManifestIssue[] = [];
  if (Buffer.byteLength(source, "utf8") > APP_GROUP_MANIFEST_MAX_BYTES) {
    return {
      errors: [{
        path: "$",
        code: "ManifestTooLarge",
        message: `Manifest exceeds the ${APP_GROUP_MANIFEST_MAX_BYTES / 1024} KB limit`,
      }],
    };
  }

  let raw: unknown;
  try {
    const document = parseDocument(source);
    if (document.errors.length) {
      return {
        errors: document.errors.map((error) => ({
          path: "$",
          code: "InvalidYaml",
          message: error.message,
        })),
      };
    }
    raw = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    return {
      errors: [{
        path: "$",
        code: "InvalidYaml",
        message: error instanceof Error ? error.message : "YAML could not be parsed",
      }],
    };
  }

  if (!isRecord(raw)) {
    return { errors: [{ path: "$", code: "InvalidManifest", message: "Manifest root must be an object" }] };
  }

  rejectUnknown(raw, ["apiVersion", "kind", "metadata", "spec"], "$", errors);
  const apiVersion = stringValue(raw.apiVersion, "$.apiVersion", errors, { required: true });
  const kind = stringValue(raw.kind, "$.kind", errors, { required: true });
  if (apiVersion && apiVersion !== APP_GROUP_MANIFEST_API_VERSION) {
    errors.push({ path: "$.apiVersion", code: "UnsupportedApiVersion", message: `Expected ${APP_GROUP_MANIFEST_API_VERSION}` });
  }
  if (kind && kind !== APP_GROUP_MANIFEST_KIND) {
    errors.push({ path: "$.kind", code: "UnsupportedKind", message: `Expected ${APP_GROUP_MANIFEST_KIND}` });
  }

  const metadata = objectValue(raw.metadata, "$.metadata", errors, true);
  if (metadata) rejectUnknown(metadata, ["name", "description"], "$.metadata", errors);
  const metadataName = metadata ? stringValue(metadata.name, "$.metadata.name", errors, { required: true, max: 63 }) : undefined;
  if (metadataName && !namePattern.test(metadataName)) {
    errors.push({ path: "$.metadata.name", code: "InvalidName", message: "Use lowercase letters, numbers and single hyphens only" });
  }
  const description = metadata ? stringValue(metadata.description, "$.metadata.description", errors, { max: 1000 }) : undefined;

  const spec = raw.spec === undefined ? {} : objectValue(raw.spec, "$.spec", errors, true);
  if (spec) rejectUnknown(spec, ["runtimeState", "variables", "secrets", "configs", "apps"], "$.spec", errors);
  const runtimeState = enumString(spec?.runtimeState ?? "Stopped", "$.spec.runtimeState", runtimeStates, errors) as "Running" | "Stopped" | undefined;

  const variables = parseVariables(spec?.variables, errors);
  const secrets = parseSecrets(spec?.secrets, errors);
  const configs = parseConfigs(spec?.configs, errors);
  const apps = parseApps(spec?.apps, errors);

  uniqueBy(variables, (item) => item.name, "$.spec.variables", "name", errors);
  uniqueBy(secrets, (item) => item.name, "$.spec.secrets", "name", errors);
  uniqueBy(configs, (item) => item.name, "$.spec.configs", "name", errors);
  uniqueBy(apps, (item) => item.name, "$.spec.apps", "name", errors);

  const variableNames = new Set(variables.map((item) => item.name));
  const secretNames = new Set(secrets.map((item) => item.name));
  const configNames = new Set(configs.map((item) => item.name));
  for (const [index, app] of apps.entries()) {
    for (const [attachmentIndex, attachment] of app.variables.entries()) {
      if (!variableNames.has(attachment.source)) {
        errors.push({
          path: `$.spec.apps[${index}].variables[${attachmentIndex}].source`,
          code: "UnknownVariable",
          message: `Variable "${attachment.source}" is not defined in spec.variables`,
        });
      }
    }
    for (const [attachmentIndex, attachment] of app.secrets.entries()) {
      if (!secretNames.has(attachment.source)) {
        errors.push({
          path: `$.spec.apps[${index}].secrets[${attachmentIndex}].source`,
          code: "UnknownSecret",
          message: `Secret "${attachment.source}" is not defined in spec.secrets`,
        });
      }
    }
    for (const [attachmentIndex, attachment] of app.configs.entries()) {
      if (!configNames.has(attachment.source)) {
        errors.push({
          path: `$.spec.apps[${index}].configs[${attachmentIndex}].source`,
          code: "UnknownConfig",
          message: `Config "${attachment.source}" is not defined in spec.configs`,
        });
      }
    }
  }

  if (errors.length || !metadataName || !runtimeState || apiVersion !== APP_GROUP_MANIFEST_API_VERSION || kind !== APP_GROUP_MANIFEST_KIND) {
    return { errors };
  }

  return {
    errors,
    manifest: {
      apiVersion: APP_GROUP_MANIFEST_API_VERSION,
      kind: APP_GROUP_MANIFEST_KIND,
      metadata: {
        name: metadataName,
        ...(description ? { description } : {}),
      },
      spec: {
        runtimeState,
        variables,
        secrets,
        configs,
        apps,
      },
    },
  };
}

export function redactedManifestPreview(manifest: AppGroupManifest) {
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      secrets: manifest.spec.secrets.map((secret) => ({
        ...secret,
        value: "<redacted>",
      })),
    },
  };
}

function parseVariables(value: unknown, errors: ManifestIssue[]) {
  const list = arrayValue(value, "$.spec.variables", errors);
  return list.flatMap((entry, index) => {
    const path = `$.spec.variables[${index}]`;
    const row = objectValue(entry, path, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["name", "description", "value"], path, errors);
    const name = stringValue(row.name, `${path}.name`, errors, { required: true, max: 128 });
    const description = stringValue(row.description, `${path}.description`, errors, { max: 1000 });
    const variableValue = stringValue(row.value, `${path}.value`, errors, { required: true, max: 20000, allowEmpty: true });
    if (name && !runtimeConfigNamePattern.test(name)) {
      errors.push({ path: `${path}.name`, code: "InvalidVariableName", message: "Variable names must match [A-Za-z_][A-Za-z0-9_]*" });
    }
    return name !== undefined && variableValue !== undefined ? [{ name, ...(description ? { description } : {}), value: variableValue }] : [];
  });
}

function parseSecrets(value: unknown, errors: ManifestIssue[]) {
  const list = arrayValue(value, "$.spec.secrets", errors);
  return list.flatMap((entry, index) => {
    const path = `$.spec.secrets[${index}]`;
    const row = objectValue(entry, path, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["name", "description", "type", "fileName", "value"], path, errors);
    const name = stringValue(row.name, `${path}.name`, errors, { required: true, max: 128 });
    const description = stringValue(row.description, `${path}.description`, errors, { max: 1000 });
    const type = enumString(row.type ?? "Text", `${path}.type`, new Set(["Text", "Binary"]), errors) as "Text" | "Binary" | undefined;
    const fileName = stringValue(row.fileName, `${path}.fileName`, errors, { max: 255 });
    const secretValue = stringValue(row.value, `${path}.value`, errors, { required: true, max: 90000, allowEmpty: true });

    if (name && !secretNamePattern.test(name)) {
      errors.push({ path: `${path}.name`, code: "InvalidSecretName", message: "Secret name contains unsupported characters" });
    }
    if (type === "Text" && fileName) {
      errors.push({ path: `${path}.fileName`, code: "InvalidSecretMetadata", message: "fileName is supported only for Binary secrets" });
    }
    if (type === "Binary" && secretValue !== undefined && !validBase64(secretValue)) {
      errors.push({ path: `${path}.value`, code: "InvalidBase64", message: "Binary secret value must be valid Base64" });
    }
    if (secretValue !== undefined) {
      const bytes = type === "Binary" && validBase64(secretValue)
        ? Buffer.from(secretValue, "base64").length
        : Buffer.byteLength(secretValue, "utf8");
      if (bytes > 64 * 1024) {
        errors.push({ path: `${path}.value`, code: "SecretTooLarge", message: "Secret value exceeds 64 KB" });
      }
    }

    return name !== undefined && type !== undefined && secretValue !== undefined
      ? [{ name, ...(description ? { description } : {}), type, ...(fileName ? { fileName } : {}), value: secretValue }]
      : [];
  });
}

function parseConfigs(value: unknown, errors: ManifestIssue[]) {
  const list = arrayValue(value, "$.spec.configs", errors);
  return list.flatMap((entry, index) => {
    const path = `$.spec.configs[${index}]`;
    const row = objectValue(entry, path, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["name", "description", "content"], path, errors);
    const name = stringValue(row.name, `${path}.name`, errors, { required: true, max: 128 });
    const description = stringValue(row.description, `${path}.description`, errors, { max: 1000 });
    const configContent = stringValue(row.content, `${path}.content`, errors, { required: true, max: 200000, allowEmpty: true });
    return name !== undefined && configContent !== undefined
      ? [{ name, ...(description ? { description } : {}), content: configContent }]
      : [];
  });
}

function parseApps(value: unknown, errors: ManifestIssue[]): AppGroupManifest["spec"]["apps"] {
  const list = arrayValue(value, "$.spec.apps", errors);
  return list.flatMap((entry, index) => {
    const path = `$.spec.apps[${index}]`;
    const row = objectValue(entry, path, errors, true);
    if (!row) return [];
    rejectUnknown(row, [
      "name", "description", "image", "registry", "desiredReplicas", "runtimeState", "resources",
      "environment", "healthCheck", "entrypoint", "command", "workingDir", "user",
      "readOnlyRootFilesystem", "stopGracePeriodSeconds", "restartPolicy", "updatePolicy",
      "variables", "secrets", "configs", "volumes", "httpEndpoints",
    ], path, errors);

    const name = stringValue(row.name, `${path}.name`, errors, { required: true, max: 63 });
    if (name && !namePattern.test(name)) {
      errors.push({ path: `${path}.name`, code: "InvalidName", message: "Use lowercase letters, numbers and single hyphens only" });
    }
    const description = stringValue(row.description, `${path}.description`, errors, { max: 1000 });
    const image = stringValue(row.image, `${path}.image`, errors, { required: true, max: 512 });
    const registry = stringValue(row.registry, `${path}.registry`, errors, { max: 128 });
    const desiredReplicas = integerValue(row.desiredReplicas ?? 1, `${path}.desiredReplicas`, errors, 0, 100);
    const runtimeState = enumString(row.runtimeState ?? "Running", `${path}.runtimeState`, runtimeStates, errors) as "Running" | "Stopped" | undefined;

    const resources = objectValue(row.resources, `${path}.resources`, errors, true);
    if (resources) rejectUnknown(resources, ["cpu", "memoryBytes", "gpu"], `${path}.resources`, errors);
    const cpu = numberValue(resources?.cpu, `${path}.resources.cpu`, errors, 0, 128);
    const memoryBytes = integerValue(resources?.memoryBytes, `${path}.resources.memoryBytes`, errors, 134217728);
    const gpu = integerValue(resources?.gpu ?? 0, `${path}.resources.gpu`, errors, 0, 0);

    const environment = stringMapValue(row.environment, `${path}.environment`, errors);
    const healthCheck = optionalRecord(row.healthCheck, `${path}.healthCheck`, errors);
    const entrypoint = stringValue(row.entrypoint, `${path}.entrypoint`, errors);
    const command = stringArrayValue(row.command, `${path}.command`, errors);
    const workingDir = stringValue(row.workingDir, `${path}.workingDir`, errors);
    const user = stringValue(row.user, `${path}.user`, errors);
    const readOnlyRootFilesystem = booleanValue(row.readOnlyRootFilesystem ?? false, `${path}.readOnlyRootFilesystem`, errors);
    const stopGracePeriodSeconds = integerValue(row.stopGracePeriodSeconds ?? 30, `${path}.stopGracePeriodSeconds`, errors, 0);
    const restartPolicy = optionalRecord(row.restartPolicy, `${path}.restartPolicy`, errors);
    const updatePolicy = optionalRecord(row.updatePolicy, `${path}.updatePolicy`, errors);

    const variables = parseVariableAttachments(row.variables, path, errors);
    const secrets = parseSecretAttachments(row.secrets, path, errors);
    const configs = parseConfigAttachments(row.configs, path, errors);
    const volumes = parseVolumeAttachments(row.volumes, path, errors);
    const httpEndpoints = parseHttpEndpoints(row.httpEndpoints, path, errors);

    uniqueBy(variables, (item) => item.targetName, `${path}.variables`, "targetName", errors);
    uniqueBy(secrets, (item) => item.targetName, `${path}.secrets`, "targetName", errors);
    uniqueBy(configs, (item) => item.targetPath, `${path}.configs`, "targetPath", errors);
    uniqueBy(volumes, (item) => item.mountPath, `${path}.volumes`, "mountPath", errors);
    uniqueBy(httpEndpoints, (item) => item.name, `${path}.httpEndpoints`, "name", errors);

    if ([name, image, desiredReplicas, runtimeState, cpu, memoryBytes, gpu, readOnlyRootFilesystem, stopGracePeriodSeconds].some((part) => part === undefined)) {
      return [];
    }

    return [{
      name: name!,
      ...(description ? { description } : {}),
      image: image!,
      ...(registry ? { registry } : {}),
      desiredReplicas: desiredReplicas!,
      runtimeState: runtimeState!,
      resources: { cpu: cpu!, memoryBytes: memoryBytes!, gpu: gpu! },
      environment,
      ...(healthCheck ? { healthCheck } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      command,
      ...(workingDir ? { workingDir } : {}),
      ...(user ? { user } : {}),
      readOnlyRootFilesystem: readOnlyRootFilesystem!,
      stopGracePeriodSeconds: stopGracePeriodSeconds!,
      ...(restartPolicy ? { restartPolicy } : {}),
      ...(updatePolicy ? { updatePolicy } : {}),
      variables,
      secrets,
      configs,
      volumes,
      httpEndpoints,
    }];
  });
}

function parseVariableAttachments(value: unknown, appPath: string, errors: ManifestIssue[]) {
  const path = `${appPath}.variables`;
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectValue(entry, rowPath, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["source", "targetName"], rowPath, errors);
    const source = stringValue(row.source, `${rowPath}.source`, errors, { required: true });
    const targetName = stringValue(row.targetName ?? source, `${rowPath}.targetName`, errors, { required: true, max: 128 });
    if (targetName && !runtimeConfigNamePattern.test(targetName)) {
      errors.push({ path: `${rowPath}.targetName`, code: "InvalidVariableName", message: "targetName must match [A-Za-z_][A-Za-z0-9_]*" });
    }
    return source && targetName ? [{ source, targetName }] : [];
  });
}

function parseSecretAttachments(value: unknown, appPath: string, errors: ManifestIssue[]) {
  const path = `${appPath}.secrets`;
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectValue(entry, rowPath, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["source", "targetName"], rowPath, errors);
    const source = stringValue(row.source, `${rowPath}.source`, errors, { required: true });
    const targetName = stringValue(row.targetName ?? source, `${rowPath}.targetName`, errors, { required: true, max: 128 });
    if (targetName && !secretNamePattern.test(targetName)) {
      errors.push({ path: `${rowPath}.targetName`, code: "InvalidSecretName", message: "Secret targetName contains unsupported characters" });
    }
    return source && targetName ? [{ source, targetName }] : [];
  });
}

function parseConfigAttachments(value: unknown, appPath: string, errors: ManifestIssue[]) {
  const path = `${appPath}.configs`;
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectValue(entry, rowPath, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["source", "targetPath"], rowPath, errors);
    const source = stringValue(row.source, `${rowPath}.source`, errors, { required: true });
    const targetPath = stringValue(row.targetPath, `${rowPath}.targetPath`, errors, { required: true, max: 512 });
    if (targetPath && !safeAbsoluteFilePath(targetPath)) {
      errors.push({ path: `${rowPath}.targetPath`, code: "InvalidTargetPath", message: "targetPath must be an absolute file path without '..' segments" });
    }
    return source && targetPath ? [{ source, targetPath }] : [];
  });
}

function parseVolumeAttachments(value: unknown, appPath: string, errors: ManifestIssue[]) {
  const path = `${appPath}.volumes`;
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectValue(entry, rowPath, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["source", "mountPath", "mode"], rowPath, errors);
    const source = stringValue(row.source, `${rowPath}.source`, errors, { required: true });
    const mountPath = stringValue(row.mountPath, `${rowPath}.mountPath`, errors, { required: true, max: 255 });
    const mode = enumString(row.mode ?? "ReadWrite", `${rowPath}.mode`, attachmentModes, errors) as "ReadOnly" | "ReadWrite" | undefined;
    if (mountPath && !mountPath.startsWith("/")) {
      errors.push({ path: `${rowPath}.mountPath`, code: "InvalidMountPath", message: "mountPath must be absolute" });
    }
    return source && mountPath && mode ? [{ source, mountPath, mode }] : [];
  });
}

function parseHttpEndpoints(value: unknown, appPath: string, errors: ManifestIssue[]) {
  const path = `${appPath}.httpEndpoints`;
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectValue(entry, rowPath, errors, true);
    if (!row) return [];
    rejectUnknown(row, ["name", "containerPort", "protocolMode", "domains"], rowPath, errors);
    const name = stringValue(row.name, `${rowPath}.name`, errors, { required: true, max: 63 });
    if (name && !namePattern.test(name)) {
      errors.push({ path: `${rowPath}.name`, code: "InvalidName", message: "Use lowercase letters, numbers and single hyphens only" });
    }
    const containerPort = integerValue(row.containerPort, `${rowPath}.containerPort`, errors, 1, 65535);
    const protocolMode = enumString(row.protocolMode ?? "HTTP_REDIRECT_TO_HTTPS", `${rowPath}.protocolMode`, endpointProtocols, errors) as AppGroupManifest["spec"]["apps"][number]["httpEndpoints"][number]["protocolMode"] | undefined;
    const domains = stringArrayValue(row.domains, `${rowPath}.domains`, errors);
    uniqueBy(domains, (item) => item, `${rowPath}.domains`, "hostname", errors);
    return name && containerPort && protocolMode ? [{ name, containerPort, protocolMode, domains }] : [];
  });
}

function arrayValue(value: unknown, path: string, errors: ManifestIssue[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, code: "ExpectedArray", message: "Expected a list" });
    return [];
  }
  return value;
}

function objectValue(value: unknown, path: string, errors: ManifestIssue[], required = false): Dict | undefined {
  if (value === undefined) {
    if (required) errors.push({ path, code: "Required", message: "Field is required" });
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push({ path, code: "ExpectedObject", message: "Expected an object" });
    return undefined;
  }
  return value;
}

function optionalRecord(value: unknown, path: string, errors: ManifestIssue[]) {
  return value === undefined ? undefined : objectValue(value, path, errors);
}

function stringValue(
  value: unknown,
  path: string,
  errors: ManifestIssue[],
  options: { required?: boolean; max?: number; allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) errors.push({ path, code: "Required", message: "Field is required" });
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push({ path, code: "ExpectedString", message: "Expected text" });
    return undefined;
  }
  if (!options.allowEmpty && options.required && value.length === 0) {
    errors.push({ path, code: "Required", message: "Field must not be empty" });
    return undefined;
  }
  if (options.max !== undefined && value.length > options.max) {
    errors.push({ path, code: "TooLong", message: `Maximum length is ${options.max} characters` });
  }
  return value;
}

function enumString(value: unknown, path: string, values: Set<string>, errors: ManifestIssue[]) {
  const result = stringValue(value, path, errors, { required: true });
  if (result && !values.has(result)) {
    errors.push({ path, code: "InvalidValue", message: `Expected one of: ${[...values].join(", ")}` });
    return undefined;
  }
  return result;
}

function integerValue(value: unknown, path: string, errors: ManifestIssue[], min?: number, max?: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push({ path, code: "ExpectedInteger", message: "Expected an integer" });
    return undefined;
  }
  if (min !== undefined && value < min) errors.push({ path, code: "TooSmall", message: `Minimum value is ${min}` });
  if (max !== undefined && value > max) errors.push({ path, code: "TooLarge", message: `Maximum value is ${max}` });
  return value;
}

function numberValue(value: unknown, path: string, errors: ManifestIssue[], min?: number, max?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, code: "ExpectedNumber", message: "Expected a number" });
    return undefined;
  }
  if (min !== undefined && value < min) errors.push({ path, code: "TooSmall", message: `Minimum value is ${min}` });
  if (max !== undefined && value > max) errors.push({ path, code: "TooLarge", message: `Maximum value is ${max}` });
  return value;
}

function booleanValue(value: unknown, path: string, errors: ManifestIssue[]) {
  if (typeof value !== "boolean") {
    errors.push({ path, code: "ExpectedBoolean", message: "Expected true or false" });
    return undefined;
  }
  return value;
}

function stringArrayValue(value: unknown, path: string, errors: ManifestIssue[]) {
  return arrayValue(value, path, errors).flatMap((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ path: `${path}[${index}]`, code: "ExpectedString", message: "Expected text" });
      return [];
    }
    return [entry];
  });
}

function stringMapValue(value: unknown, path: string, errors: ManifestIssue[]) {
  if (value === undefined) return {};
  const row = objectValue(value, path, errors);
  if (!row) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(row)) {
    if (typeof item !== "string") {
      errors.push({ path: `${path}.${key}`, code: "ExpectedString", message: "Environment values must be text" });
    } else {
      result[key] = item;
    }
  }
  return result;
}

function uniqueBy<T>(items: T[], key: (item: T) => string, path: string, label: string, errors: ManifestIssue[]) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const value = key(item);
    if (seen.has(value)) {
      errors.push({ path: `${path}[${index}]`, code: "DuplicateValue", message: `Duplicate ${label}: ${value}` });
    }
    seen.add(value);
  }
}

function rejectUnknown(row: Dict, allowed: string[], path: string, errors: ManifestIssue[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(row)) {
    if (!allowedSet.has(key)) {
      errors.push({ path: `${path}.${key}`, code: "UnknownField", message: `Unknown field "${key}"` });
    }
  }
}

function safeAbsoluteFilePath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return path.startsWith("/") && !path.endsWith("/") && !parts.includes("..");
}

function validBase64(value: string) {
  const normalized = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return false;
  return Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === normalized;
}

function isRecord(value: unknown): value is Dict {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
