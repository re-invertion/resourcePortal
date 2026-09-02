export const appGroupForm = {
  name: "",
  description: "",
  runtimeState: "",
};

export const singleAppForm = {
  name: "",
  description: "",
  image: "",
  registryId: "",
  desiredReplicas: 0,
  runtimeState: "",
  cpu: 0,
  memoryBytes: 134217728,
  gpu: 0,
  environment: {},
  healthCheck: {},
  entrypoint: "",
  command: [""],
  workingDir: "",
  user: "",
  readOnlyRootFilesystem: false,
  stopGracePeriodSeconds: 0,
  restartPolicy: {},
  updatePolicy: {},
};

export const variableForm = {
  name: "",
  description: "",
  value: "",
};

export const configForm = {
  name: "",
  description: "",
  content: "",
};

export const secretForm = {
  name: "",
  description: "",
  type: "",
  fileName: "",
  value: "",
};

export const httpEndpointForm = {
  name: "",
  containerPort: 80,
  protocolMode: "HTTP",
};

export const volumeForm = {
  name: "",
  description: "",
  sizeBytes: 1048576,
};

export const resizeVolumeForm = {
  sizeBytes: 1048576,
};

export const registryForm = {
  name: "",
  description: "",
  host: "",
  tlsMode: "",
  authType: "",
  username: "",
  credential: "",
};

export const deployForm = {
  note: "",
  force: false,
  correlationId: "",
};

export const rollbackForm = {
  note: "",
  correlationId: "",
};

export const runtimeConfigForm = {
  environment: {},
  secrets: [{ name: "", description: "", value: "" }],
  removeSecrets: [""],
};

export const attachVariableForm = {
  variableId: "",
  targetName: "",
};

export const attachConfigForm = {
  configId: "",
  targetPath: "",
};

export const attachSecretForm = {
  secretId: "",
  targetName: "",
};

export const attachVolumeForm = {
  volumeId: "",
  mountPath: "",
  mode: "",
};

export const detachAttachmentForm = {
  attachmentId: "",
};

export const domainForm = {
  type: "",
  prefix: "",
  hostname: "",
  customRootDomainId: "",
  subdomain: "",
  httpEndpointId: "",
  tlsEnabled: false,
};

export const customRootDomainForm = {
  rootDomain: "",
};

export const membershipForm = {
  userId: "",
  roleIds: [""],
};

export const invitationForm = {
  email: "",
  roleIds: [""],
};

export const groupForm = {
  name: "",
  description: "",
};

export const authPolicyForm = {
  allowPlatformLogin: false,
  allowTenantIdentityProviders: false,
  requireTenantIdentityProvider: false,
};

export const identityProviderForm = {
  name: "",
  protocol: "",
  issuer: "",
  metadataUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: [""],
  usePkce: false,
  enabled: false,
};

export const oauthApplicationForm = {
  name: "",
  type: "",
  redirectUris: [""],
  postLogoutRedirectUris: [""],
};

export const tenantServiceIdentityForm = {
  name: "",
  description: "",
  roleIds: [""],
};

export const platformServiceIdentityForm = {
  name: "",
  description: "",
};

export const quotaForm = {
  cpu: 0,
  memoryBytes: 0,
  gpu: 0,
  storageBytes: 0,
  maxSingleApps: 0,
  maxVolumes: 0,
};

export const topUpForm = {
  amount: "",
  reference: "",
};

export const auditFilterForm = {
  action: "",
  actor: "",
  resourceType: "",
  from: "",
  to: "",
  limit: 100,
  format: "json",
};

export const platformMaintenanceForm = {
  enabled: false,
  reason: "",
};

export const infrastructureMaintenanceForm = {
  enabled: false,
};

export const priceListForm = {
  effectiveFrom: "",
  cpuCreditsPerVcpuHour: "",
  memoryCreditsPerGbHour: "",
  storageCreditsPerGbHour: "",
  gpuCreditsPerGpuHour: "",
};

export const voucherForm = {
  valueCredits: "",
  expiresAt: "",
};

export const paymentForm = {
  tenantId: "",
  amountCredits: "",
  reference: "",
  sourceTransactionId: "",
};

export const refundForm = {
  tenantId: "",
  amountCredits: "",
  reference: "",
  reason: "",
  sourceTransactionId: "",
};

export const correctionForm = {
  tenantId: "",
  amountCredits: "",
  reference: "",
  reason: "",
  sourceTransactionId: "",
};
