import {
  AppGroup,
  AppGroupDeployment,
  Config,
  ConfigAttachment,
  DeploymentEvent,
  Secret,
  SecretAttachment,
  SingleApp,
  Variable,
  VariableAttachment,
} from "@prisma/client";

type AppGroupWithRelations = AppGroup & {
  singleApps?: SingleApp[];
  deployments?: AppGroupDeployment[];
  tenant?: {
    status: string;
    billing?: {
      balance: { lte(value: number): boolean };
    } | null;
  };
};

export function mapAppGroup(appGroup: AppGroupWithRelations) {
  const runtimeBlockers = appGroupRuntimeBlockers(appGroup);

  return {
    ...appGroup,
    tenant: undefined,
    effectiveRuntimeState:
      runtimeBlockers.length > 0 ? "Stopped" : appGroup.runtimeState,
    runtimeBlockers,
    singleApps: appGroup.singleApps?.map((singleApp) =>
      mapSingleApp(singleApp, runtimeBlockers),
    ),
  };
}

export function mapSingleApp(
  singleApp: SingleApp,
  inheritedRuntimeBlockers: string[] = [],
) {
  const runtimeBlockers = [
    ...inheritedRuntimeBlockers,
    ...singleAppRuntimeBlockers(singleApp),
  ];

  return {
    ...singleApp,
    cpu: singleApp.cpu.toString(),
    memoryBytes: singleApp.memoryBytes.toString(),
    effectiveRuntimeState:
      runtimeBlockers.length > 0 ? "Stopped" : singleApp.runtimeState,
    effectiveReplicas:
      runtimeBlockers.length > 0 ? 0 : singleApp.desiredReplicas,
    runtimeBlockers,
  };
}

export function mapAppGroupDeployment(deployment: AppGroupDeployment) {
  return {
    ...deployment,
    stackConfig:
      deployment.stackConfig === null
        ? null
        : (JSON.parse(deployment.stackConfig) as unknown),
  };
}

export function mapDeploymentEvent(event: DeploymentEvent) {
  return event;
}

export function mapVariable(variable: Variable & { attachments?: VariableAttachment[] }) {
  return {
    ...variable,
    attachmentCount: variable.attachments?.length,
  };
}

export function mapVariableAttachment(attachment: VariableAttachment) {
  return attachment;
}

export function mapConfig(config: Config & { attachments?: ConfigAttachment[] }) {
  return {
    ...config,
    attachmentCount: config.attachments?.length,
  };
}

export function mapConfigAttachment(attachment: ConfigAttachment) {
  return attachment;
}

export function mapSecret(secret: Secret & { attachments?: SecretAttachment[] }) {
  return {
    ...secret,
    attachmentCount: secret.attachments?.length,
    hasValue: true,
  };
}

export function mapSecretAttachment(attachment: SecretAttachment) {
  return attachment;
}

function appGroupRuntimeBlockers(appGroup: AppGroupWithRelations) {
  return [
    appGroup.status === "Deleting" ? "AppGroupDeleting" : undefined,
    appGroup.status === "Error" ? "AppGroupError" : undefined,
    appGroup.runtimeState === "Stopped" ? "AppGroupStopped" : undefined,
    appGroup.currentDeploymentVersion === null ? "AppGroupNotDeployed" : undefined,
    appGroup.tenant?.status === "Suspended" ? "TenantSuspended" : undefined,
    appGroup.tenant?.billing?.balance.lte(0) ? "BillingSuspended" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
}

function singleAppRuntimeBlockers(singleApp: SingleApp) {
  return [
    singleApp.pendingDeletion ? "SingleAppPendingDeletion" : undefined,
    singleApp.runtimeState === "Stopped" ? "SingleAppStopped" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
}
