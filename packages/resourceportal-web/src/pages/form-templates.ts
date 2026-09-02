export const appGroupForm = {
  name: "",
  description: "",
  runtimeState: "Stopped",
};

export const singleAppForm = {
  name: "",
  description: "",
  image: "",
  registryId: "",
  desiredReplicas: null,
  runtimeState: "Stopped",
  cpu: 0,
  memoryBytes: 134217728,
  gpu: null,
  environment: {},
  healthCheck: {},
  entrypoint: "",
  command: [""],
  workingDir: "",
  user: "",
  readOnlyRootFilesystem: null,
  stopGracePeriodSeconds: null,
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
  type: "Text",
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
  tlsMode: "TLS",
  authType: "None",
  username: "",
  credential: "",
};

export const deployForm = {
  note: "",
  force: null,
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
  mode: "ReadOnly",
};

export const detachAttachmentForm = {
  attachmentId: "",
};

export const domainForm = {
  type: "Managed",
  prefix: "",
  hostname: "",
  customRootDomainId: "",
  subdomain: "",
  httpEndpointId: "",
  tlsEnabled: null,
};

export const domainUpdateForm = {
  httpEndpointId: "",
  tlsEnabled: null,
};

export const customRootDomainForm = {
  rootDomain: "",
};

export const customRootDomainUpdateForm = {
  verificationStatus: "Pending",
};

export const membershipForm = {
  userId: "",
  roleIds: [""],
};

export const membershipUpdateForm = {
  status: "Active",
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
  allowPlatformLogin: null,
  allowTenantIdentityProviders: null,
  requireTenantIdentityProvider: null,
};

export const identityProviderForm = {
  name: "",
  protocol: "OIDC",
  issuer: "",
  metadataUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: [""],
  usePkce: null,
  enabled: null,
};

export const oauthApplicationForm = {
  name: "",
  type: "Web",
  redirectUris: [""],
  postLogoutRedirectUris: [""],
};

export const oauthApplicationUpdateForm = {
  name: "",
  redirectUris: [""],
  postLogoutRedirectUris: [""],
};

export const tenantServiceIdentityForm = {
  name: "",
  description: "",
  roleIds: [""],
};

export const tenantServiceIdentityUpdateForm = {
  name: "",
  description: "",
  status: "Active",
  roleIds: [""],
};

export const platformServiceIdentityForm = {
  name: "",
  description: "",
};

export const platformServiceIdentityUpdateForm = {
  name: "",
  description: "",
  status: "Active",
};

export const quotaForm = {
  cpu: null,
  memoryBytes: null,
  gpu: null,
  storageBytes: null,
  maxSingleApps: null,
  maxVolumes: null,
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
