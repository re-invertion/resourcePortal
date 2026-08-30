type DiscardSnapshot = {
  appGroup: { runtimeState: string };
  singleApps: Array<{
    id: string;
    variables?: Array<{
      id: string;
      variableId: string;
      variableName: string;
      targetName: string;
      value: string;
    }>;
    configs?: Array<{
      id: string;
      configId: string;
      configName: string;
      contentVersion: number;
      targetPath: string;
      content: string;
    }>;
    volumes?: Array<{
      id: string;
      volumeId: string;
      mountPath: string;
      mode: "ReadOnly" | "ReadWrite";
    }>;
    httpEndpoints?: Array<{
      id: string;
      name: string;
      containerPort: number;
      protocolMode: string;
      domains?: Array<{ id: string }>;
    }>;
  }>;
};

export function buildDiscardRestorePlan(snapshot: DiscardSnapshot) {
  const variables = new Map<
    string,
    { id: string; name: string; value: string }
  >();
  const configs = new Map<
    string,
    { id: string; name: string; content: string; contentVersion: number }
  >();
  const variableAttachments: Array<{
    id: string;
    variableId: string;
    singleAppId: string;
    targetName: string;
  }> = [];
  const configAttachments: Array<{
    id: string;
    configId: string;
    singleAppId: string;
    targetPath: string;
  }> = [];
  const volumeAttachments: Array<{
    id: string;
    volumeId: string;
    singleAppId: string;
    mountPath: string;
    mode: "ReadOnly" | "ReadWrite";
  }> = [];
  const httpEndpoints: Array<{
    id: string;
    singleAppId: string;
    name: string;
    containerPort: number;
    protocolMode: string;
  }> = [];
  const domainAssignments: Array<{
    domainId: string;
    httpEndpointId: string;
  }> = [];

  for (const singleApp of snapshot.singleApps) {
    for (const variable of singleApp.variables ?? []) {
      variables.set(variable.variableId, {
        id: variable.variableId,
        name: variable.variableName,
        value: variable.value,
      });
      variableAttachments.push({
        id: variable.id,
        variableId: variable.variableId,
        singleAppId: singleApp.id,
        targetName: variable.targetName,
      });
    }

    for (const config of singleApp.configs ?? []) {
      configs.set(config.configId, {
        id: config.configId,
        name: config.configName,
        content: config.content,
        contentVersion: config.contentVersion,
      });
      configAttachments.push({
        id: config.id,
        configId: config.configId,
        singleAppId: singleApp.id,
        targetPath: config.targetPath,
      });
    }

    for (const volume of singleApp.volumes ?? []) {
      volumeAttachments.push({
        id: volume.id,
        volumeId: volume.volumeId,
        singleAppId: singleApp.id,
        mountPath: volume.mountPath,
        mode: volume.mode,
      });
    }

    for (const endpoint of singleApp.httpEndpoints ?? []) {
      httpEndpoints.push({
        id: endpoint.id,
        singleAppId: singleApp.id,
        name: endpoint.name,
        containerPort: endpoint.containerPort,
        protocolMode: endpoint.protocolMode,
      });

      for (const domain of endpoint.domains ?? []) {
        domainAssignments.push({
          domainId: domain.id,
          httpEndpointId: endpoint.id,
        });
      }
    }
  }

  return {
    variables: [...variables.values()],
    variableAttachments,
    configs: [...configs.values()],
    configAttachments,
    volumeAttachments,
    httpEndpoints,
    domainAssignments,
  };
}
