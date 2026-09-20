import { parse } from "yaml";

type ComposeNetwork = {
  external?: boolean;
  name?: string;
};

type ComposeService = {
  deploy?: {
    labels?: Record<string, string> | string[];
  };
};

type ComposeStack = {
  networks?: Record<string, ComposeNetwork>;
  services?: Record<string, ComposeService>;
};

export type AppGroupNetworkTopology = {
  mode: "single" | "legacy";
  traefikRequired: boolean;
};

export function inspectAppGroupNetworkTopology(
  renderedStack: string,
  appGroupNetworkName: string,
  legacyIngressNetworkName: string,
): AppGroupNetworkTopology {
  const stack = parse(renderedStack) as ComposeStack;
  const networks = Object.values(stack.networks ?? {});
  const appGroupNetwork = networks.find(
    (network) => network?.name === appGroupNetworkName,
  );
  if (!appGroupNetwork) {
    throw new Error(`Rendered stack does not declare ${appGroupNetworkName}`);
  }

  const labels = Object.values(stack.services ?? {}).flatMap((service) =>
    normalizeLabels(service?.deploy?.labels),
  );
  const traefikRequired = labels.some(
    ([key, value]) => key === "traefik.enable" && value === "true",
  );
  const swarmNetworks = new Set(
    labels
      .filter(([key]) => key === "traefik.swarm.network")
      .map(([, value]) => value),
  );

  if (appGroupNetwork.external === true) {
    if (
      traefikRequired &&
      (swarmNetworks.size !== 1 || !swarmNetworks.has(appGroupNetworkName))
    ) {
      throw new Error(
        `Rendered stack Traefik routing does not target ${appGroupNetworkName}`,
      );
    }
    return { mode: "single", traefikRequired };
  }

  const legacyIngress = networks.find(
    (network) =>
      network?.external === true && network.name === legacyIngressNetworkName,
  );
  if (traefikRequired) {
    if (!legacyIngress) {
      throw new Error(
        `Legacy rendered stack does not declare ${legacyIngressNetworkName}`,
      );
    }
    if (
      swarmNetworks.size !== 1 ||
      !swarmNetworks.has(legacyIngressNetworkName)
    ) {
      throw new Error(
        `Legacy rendered stack Traefik routing does not target ${legacyIngressNetworkName}`,
      );
    }
  }

  return { mode: "legacy", traefikRequired };
}

function normalizeLabels(
  labels: Record<string, string> | string[] | undefined,
): Array<[string, string]> {
  if (!labels) return [];
  if (!Array.isArray(labels)) return Object.entries(labels);
  return labels.flatMap((label) => {
    const separator = label.indexOf("=");
    return separator > 0
      ? [[label.slice(0, separator), label.slice(separator + 1)]]
      : [];
  });
}
