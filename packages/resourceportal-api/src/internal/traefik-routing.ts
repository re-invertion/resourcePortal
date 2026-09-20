export type TraefikProtocolMode =
  | "HTTP"
  | "HTTPS"
  | "HTTP_AND_HTTPS"
  | "HTTP_REDIRECT_TO_HTTPS";

export type TraefikEndpoint = {
  name: string;
  containerPort: number;
  protocolMode: string;
  domains: Array<{ hostname: string }>;
};

export type TraefikSingleApp = {
  name: string;
  httpEndpoints: TraefikEndpoint[];
};

export type TraefikRoutingOptions = {
  certResolver?: string;
  swarmNetwork?: string;
};

export function protocolModeRequiresTls(protocolMode: string) {
  return protocolMode !== "HTTP";
}

export function renderTraefikLabels(
  singleApp: TraefikSingleApp,
  options: TraefikRoutingOptions = {
    certResolver: process.env.TRAEFIK_CERT_RESOLVER,
  },
) {
  const labels: Record<string, string> = {};

  for (const endpoint of singleApp.httpEndpoints) {
    const serviceName = `${singleApp.name}-${endpoint.name}`;
    const domains = endpoint.domains.map((domain) => domain.hostname);
    if (domains.length === 0) {
      continue;
    }

    labels[`traefik.http.services.${serviceName}.loadbalancer.server.port`] =
      String(endpoint.containerPort);

    const rule = domains.map((domain) => `Host(\`${domain}\`)`).join(" || ");

    switch (endpoint.protocolMode as TraefikProtocolMode) {
      case "HTTP":
        addRouter(labels, serviceName, serviceName, rule, false);
        break;
      case "HTTP_AND_HTTPS":
        addRouter(labels, `${serviceName}-http`, serviceName, rule, false);
        addRouter(
          labels,
          `${serviceName}-https`,
          serviceName,
          rule,
          true,
          options.certResolver,
        );
        break;
      case "HTTP_REDIRECT_TO_HTTPS": {
        const httpRouterName = `${serviceName}-http`;
        const httpsRouterName = `${serviceName}-https`;
        const middlewareName = `${serviceName}-https-redirect`;

        addRouter(labels, httpRouterName, serviceName, rule, false);
        labels[`traefik.http.routers.${httpRouterName}.middlewares`] =
          middlewareName;
        labels[
          `traefik.http.middlewares.${middlewareName}.redirectscheme.scheme`
        ] = "https";
        labels[
          `traefik.http.middlewares.${middlewareName}.redirectscheme.permanent`
        ] = "true";
        addRouter(
          labels,
          httpsRouterName,
          serviceName,
          rule,
          true,
          options.certResolver,
        );
        break;
      }
      case "HTTPS":
      default:
        addRouter(
          labels,
          serviceName,
          serviceName,
          rule,
          true,
          options.certResolver,
        );
        break;
    }
  }

  if (Object.keys(labels).length > 0) {
    labels["traefik.enable"] = "true";
    if (options.swarmNetwork) {
      labels["traefik.swarm.network"] = options.swarmNetwork;
    }
  }

  return Object.keys(labels).length > 0 ? labels : undefined;
}

function addRouter(
  labels: Record<string, string>,
  routerName: string,
  serviceName: string,
  rule: string,
  tls: boolean,
  certResolver?: string,
) {
  labels[`traefik.http.routers.${routerName}.rule`] = rule;
  labels[`traefik.http.routers.${routerName}.service`] = serviceName;

  if (tls) {
    labels[`traefik.http.routers.${routerName}.tls`] = "true";
    if (certResolver) {
      labels[`traefik.http.routers.${routerName}.tls.certresolver`] = certResolver;
    }
  }
}

export function legacyAppGroupIngressNetworkName(appGroupId: string) {
  return `rp-ingress-${appGroupId.toLowerCase()}`;
}


export function hasPublishedHttpRouting(singleApp: TraefikSingleApp) {
  return singleApp.httpEndpoints.some((endpoint) => endpoint.domains.length > 0);
}

export function appGroupNetworkName(appGroupId: string) {
  return `rp-appgroup-${appGroupId.toLowerCase()}`;
}

/** @deprecated compatibility alias for pre-v0.2 call sites/tests. */
export const appGroupPrivateNetworkName = appGroupNetworkName;
