import {
  AppGroup,
  AppGroupDeployment,
  Config,
  ConfigAttachment,
  DeploymentEvent,
  SingleApp,
  Variable,
  VariableAttachment,
} from "@prisma/client";

type AppGroupWithRelations = AppGroup & {
  singleApps?: SingleApp[];
  deployments?: AppGroupDeployment[];
};

export function mapAppGroup(appGroup: AppGroupWithRelations) {
  const runtimeBlockers = appGroupRuntimeBlockers(appGroup);

  return {
    ...appGroup,
    effectiveRuntimeState:
      runtimeBlockers.length > 0 ? "Stopped" : appGroup.runtimeState,
    runtimeBlockers,
    singleApps: appGroup.singleApps?.map(mapSingleApp),
  };
}

export function mapSingleApp(singleApp: SingleApp) {
  const runtimeBlockers = singleAppRuntimeBlockers(singleApp);

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

function appGroupRuntimeBlockers(appGroup: AppGroup) {
  return [
    appGroup.status === "Deleting" ? "AppGroupDeleting" : undefined,
    appGroup.status === "Error" ? "AppGroupError" : undefined,
    appGroup.runtimeState === "Stopped" ? "AppGroupStopped" : undefined,
    appGroup.currentDeploymentVersion === null ? "AppGroupNotDeployed" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
}

function singleAppRuntimeBlockers(singleApp: SingleApp) {
  return [
    singleApp.pendingDeletion ? "SingleAppPendingDeletion" : undefined,
    singleApp.runtimeState === "Stopped" ? "SingleAppStopped" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
}
