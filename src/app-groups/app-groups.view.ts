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
  return {
    ...appGroup,
    singleApps: appGroup.singleApps?.map(mapSingleApp),
  };
}

export function mapSingleApp(singleApp: SingleApp) {
  return {
    ...singleApp,
    cpu: singleApp.cpu.toString(),
    memoryBytes: singleApp.memoryBytes.toString(),
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
