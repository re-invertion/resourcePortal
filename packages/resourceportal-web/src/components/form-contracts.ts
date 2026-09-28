export type ReferenceOption = { value: string; label: string };
export type ReferenceOptions = Record<string, ReferenceOption[]>;

export type YupChain = {
  integer?: () => YupChain;
  min?: (value: number, message?: string) => YupChain;
  max?: (value: number, message?: string) => YupChain;
  trim?: () => YupChain;
  matches?: (regex: RegExp, message?: string) => YupChain;
  required?: (message?: string) => YupChain;
  nullable?: () => YupChain;
  oneOf?: (values: unknown[], message?: string) => YupChain;
  of?: (schema: unknown) => YupChain;
  email?: (message?: string) => YupChain;
  url?: (message?: string) => YupChain;
};

export type PreviewYupRuntime = {
  object: (shape?: Record<string, unknown>) => YupChain;
  number: () => YupChain;
  string: () => YupChain;
  boolean: () => YupChain;
  array: () => YupChain;
  mixed: () => YupChain;
};

export const numericFieldKeys = new Set([
  "cpu", "desiredReplicas", "gpu", "limit", "maxSingleApps", "maxVolumes", "memoryBytes", "replicas",
  "sizeBytes", "stopGracePeriodSeconds", "storageBytes", "containerPort",
]);

export const booleanFieldKeys = new Set([
  "allowPlatformLogin", "allowTenantIdentityProviders", "enabled", "force", "readOnlyRootFilesystem",
  "requireTenantIdentityProvider", "tlsEnabled", "usePkce",
]);

export const requiredFieldKeys = new Set([
  "name", "displayName", "contactEmail", "containerPort", "type", "protocol", "rootDomain", "email", "userId", "tenantId", "amountCredits",
]);

const enumChoices: Record<string, ReferenceOption[]> = {
  protocolMode: [
    { value: "HTTP", label: "HTTP" },
    { value: "HTTPS", label: "HTTPS" },
    { value: "HTTP_AND_HTTPS", label: "HTTP + HTTPS" },
    { value: "HTTP_REDIRECT_TO_HTTPS", label: "HTTP → HTTPS" },
  ],
  protocol: [{ value: "OIDC", label: "OIDC" }, { value: "SAML", label: "SAML" }],
  tlsMode: [{ value: "TLS", label: "TLS" }, { value: "NoTLS", label: "No TLS" }],
  authType: [
    { value: "None", label: "None" },
    { value: "UsernamePassword", label: "Username + password" },
    { value: "Token", label: "Token" },
  ],
  runtimeState: [{ value: "Running", label: "Running" }, { value: "Stopped", label: "Stopped" }],
  mode: [{ value: "ReadOnly", label: "Read only" }, { value: "ReadWrite", label: "Read / write" }],
  verificationStatus: [
    { value: "Pending", label: "Pending" },
    { value: "Verified", label: "Verified" },
    { value: "Failed", label: "Failed" },
  ],
  status: [{ value: "Active", label: "Active" }, { value: "Suspended", label: "Suspended" }],
  format: [{ value: "json", label: "JSON" }, { value: "csv", label: "CSV" }],
};

const typeChoiceSets: ReferenceOption[][] = [
  [{ value: "Managed", label: "Managed" }, { value: "Custom", label: "Custom" }],
  [{ value: "Text", label: "Text" }, { value: "Binary", label: "Binary" }],
  [
    { value: "Web", label: "Web" }, { value: "SPA", label: "SPA" },
    { value: "Native", label: "Native" }, { value: "Machine", label: "Machine" },
  ],
];

const descriptions: Record<string, string> = {
  name: "Stable name used to identify this resource in Resource Portal.",
  displayName: "Human-readable name shown throughout Resource Portal.",
  contactEmail: "Required contact address for this tenant.",
  description: "Optional human-readable explanation of the resource and its purpose.",
  containerPort: "Port exposed by the application container. Valid range: 1–65535.",
  protocolMode: "Controls whether the HTTP endpoint accepts HTTP, HTTPS, both, or redirects HTTP to HTTPS.",
  protocol: "Identity federation protocol used by this identity provider.",
  registryId: "Container registry used to pull the application image.",
  roleIds: "Roles assigned to this membership, invitation, or service identity.",
  httpEndpointId: "HTTP endpoint that receives traffic for this domain.",
  customRootDomainId: "Verified custom root domain used to build this domain.",
  variableId: "Existing AppGroup variable to attach to the SingleApp.",
  configId: "Existing AppGroup config to attach to the SingleApp.",
  secretId: "Existing AppGroup secret to attach to the SingleApp.",
  volumeId: "Existing tenant volume to mount in the SingleApp.",
  mountPath: "Absolute path inside the application container where the volume is mounted.",
  targetPath: "Path inside the application container where the config is exposed.",
  targetName: "Environment or runtime name exposed to the application.",
  runtimeState: "Requested initial runtime state for the resource.",
  desiredReplicas: "Requested number of running application replicas.",
  cpu: "CPU allocation requested for the workload.",
  memoryBytes: "Memory allocation in bytes.",
  gpu: "Number of GPUs requested by the workload.",
  sizeBytes: "Persistent storage size in bytes.",
  host: "Registry hostname used by Docker when pulling images.",
  tlsMode: "Transport security mode used when connecting to the registry.",
  authType: "Authentication method used for the registry.",
  credential: "Secret credential used only for this mutation; it is not displayed again as plaintext.",
  type: "Resource-specific type. Only values supported by the API contract are available.",
  tlsEnabled: "Whether Resource Portal should provision and use TLS for this domain.",
  issuer: "OIDC issuer URL published by the external identity provider.",
  metadataUrl: "SAML metadata URL published by the external identity provider.",
  clientId: "OAuth/OIDC client identifier configured at the identity provider.",
  clientSecret: "OAuth/OIDC client secret. Treat this value as a credential.",
  scopes: "OAuth/OIDC scopes requested during authentication.",
  usePkce: "Enables PKCE where supported by the configured identity provider.",
  enabled: "Enables or disables this configuration when the API supports an optional state.",
  email: "Email address associated with the user or invitation.",
  rootDomain: "Root DNS domain controlled for Resource Portal routing.",
};

export function choicesFor(fieldKey: string, value: unknown, references?: ReferenceOptions) {
  if (references?.[fieldKey]?.length) return references[fieldKey];
  if (fieldKey === "type" && typeof value === "string") {
    return typeChoiceSets.find((choices) => choices.some((choice) => choice.value === value));
  }
  return enumChoices[fieldKey];
}

export function descriptionFor(key: string, label: string) {
  return descriptions[key] ?? `Configure ${label.toLowerCase()} for this resource.`;
}

function call(chain: YupChain, method: keyof YupChain, ...args: unknown[]) {
  const fn = chain[method];
  return typeof fn === "function" ? (fn as (...values: unknown[]) => YupChain)(...args) : chain;
}

export function validationErrorFor(
  key: string,
  value: unknown,
  references?: ReferenceOptions,
): string | undefined {
  const required = requiredFieldKeys.has(key);
  const empty =
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);

  if (empty) {
    const rawLabel = key === "displayName" ? "Name" : key === "contactEmail" ? "Contact email" : key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);
    return required ? `${label} is required` : undefined;
  }

  const choices = choicesFor(key, value, references);
  if (choices && typeof value === "string" && !choices.some((choice) => choice.value === value)) {
    return "Choose one of the available options";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "Enter a valid number";
    if (key !== "cpu" && !Number.isInteger(value)) return "Enter a whole number";
    if (key === "containerPort" && (value < 1 || value > 65535)) return "Port must be between 1 and 65535";
    if (key !== "containerPort" && value < 0) return "Value cannot be negative";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const max = key === "description" ? 1000 : key === "contactEmail" || key === "email" ? 320 : 255;
    if (trimmed.length > max) return `Value must be at most ${max} characters`;
    if ((key === "email" || key === "contactEmail") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return "Enter a valid email address";
    }
    if ((key === "issuer" || key === "metadataUrl") && (() => { try { const url = new URL(trimmed); return url.protocol !== "http:" && url.protocol !== "https:"; } catch { return true; } })()) {
      return "Enter a valid URL";
    }
    if (/Id$/.test(key) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
      return "Choose or enter a valid UUID";
    }
  }

  if (Array.isArray(value) && value.length > 20) return "At most 20 entries are allowed";
  return undefined;
}

export function validationErrorsFor(
  values: Record<string, unknown>,
  references?: ReferenceOptions,
) {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, validationErrorFor(key, value, references)] as const)
      .filter(([, error]) => Boolean(error)),
  ) as Record<string, string>;
}

export function buildYupSchema(values: Record<string, unknown>, yup: PreviewYupRuntime, references: ReferenceOptions | undefined, fieldType: (key: string, value: unknown) => "text" | "number" | "boolean" | "list" | "object", labelFor: (key: string) => string) {
  const shape = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const type = fieldType(key, value);
    const choices = choicesFor(key, value, references);
    let schema: YupChain;
    if (choices) schema = call(yup.mixed(), "oneOf", choices.map((choice) => choice.value), "Choose one of the available options");
    else if (type === "number") {
      schema = yup.number();
      if (key !== "cpu") schema = call(schema, "integer", "Enter a whole number");
      if (key === "containerPort") {
        schema = call(schema, "min", 1, "Port must be at least 1");
        schema = call(schema, "max", 65535, "Port must be at most 65535");
      } else schema = call(schema, "min", 0, "Value cannot be negative");
    } else if (type === "boolean") schema = yup.boolean();
    else if (type === "list") {
      schema = call(yup.array(), "of", call(call(yup.string(), "trim"), "max", 1000, "Entry is too long"));
      schema = call(schema, "max", 20, "At most 20 entries are allowed");
    } else if (type === "object") schema = yup.object();
    else {
      schema = call(call(yup.string(), "trim"), "max", key === "description" ? 1000 : 255, "Value is too long");
      if (key === "email" || key === "contactEmail") schema = call(schema, "email", "Enter a valid email address");
      if (key === "issuer" || key === "metadataUrl") schema = call(schema, "url", "Enter a valid URL");
      if (/Id$/.test(key)) schema = call(schema, "matches", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Choose or enter a valid UUID");
    }
    schema = requiredFieldKeys.has(key) ? call(schema, "required", `${labelFor(key)} is required`) : call(schema, "nullable");
    return [key, schema];
  }));
  return yup.object(shape);
}
