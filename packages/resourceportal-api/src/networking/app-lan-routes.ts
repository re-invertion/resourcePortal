import { containsIpv4, parseIpv4Cidr } from "./network-addressing";

export const APP_LAN_ROUTE_PROTOCOL = "201";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK = /^rp-network-[0-9a-f-]{36}$/i;

export type ApplicationLanRoute = {
  tenantId: string;
  singleAppId: string;
  swarmServiceName: string;
  networkName: string;
  sourceNetworkCidr: string;
  destinationCidr: string;
  gatewayAddress: string;
};

export function validateLanRoutePolicy(input: unknown): ApplicationLanRoute[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Route policy must be an object");
  const value = input as { version?: unknown; routes?: unknown };
  if (value.version !== 1 || !Array.isArray(value.routes) || value.routes.length > 2048) {
    throw new Error("Invalid application LAN route snapshot");
  }
  const result: ApplicationLanRoute[] = [];
  const lookup = new Map<string, string>();
  for (const candidate of value.routes) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid route entry");
    const route = candidate as ApplicationLanRoute;
    if (!UUID.test(route.tenantId) || !UUID.test(route.singleAppId) ||
      typeof route.swarmServiceName !== "string" ||
      !/^rp_[0-9a-f_]+_[A-Za-z0-9_]+$/.test(route.swarmServiceName) ||
      !NETWORK.test(route.networkName) || typeof route.sourceNetworkCidr !== "string" ||
      typeof route.destinationCidr !== "string" || typeof route.gatewayAddress !== "string") {
      throw new Error("Invalid application routing identity");
    }
    const source = parseIpv4Cidr(route.sourceNetworkCidr);
    const destination = parseIpv4Cidr(route.destinationCidr);
    const gw = parseIpv4Cidr(route.gatewayAddress);
    if (!source || !destination || !gw || gw.prefix !== 32 ||
      source.prefix < 16 || source.prefix > 30 ||
      !containsIpv4(source, route.gatewayAddress) ||
      destination.prefix === 0) {
      throw new Error("Invalid application routing address");
    }
    const key = route.tenantId + ":" + route.singleAppId + ":" + route.destinationCidr;
    const prior = lookup.get(key);
    if (prior !== undefined && prior !== route.gatewayAddress) {
      throw new Error("Ambiguous LAN routes across multiple Site VPNs");
    }
    lookup.set(key, route.gatewayAddress);
    if (!result.some(item => JSON.stringify(item) === JSON.stringify(route))) result.push(route);
  }
  return result;
}

export function desiredRoutesForContainer(
  policy: ApplicationLanRoute[],
  labels: Record<string, string>,
  attachedNetworks: Record<string, { IPAddress?: string }>,
) {
  if (labels["resourceportal.workload"] !== "tenant") return [];
  const tenantId = labels["resourceportal.tenant-id"];
  const singleAppId = labels["resourceportal.single-app-id"];
  return policy.filter(route =>
    route.tenantId === tenantId &&
    (route.singleAppId === singleAppId ||
      (singleAppId === undefined &&
        route.swarmServiceName === labels["com.docker.swarm.service.name"])) &&
    Boolean(attachedNetworks[route.networkName]?.IPAddress) &&
    Boolean(parseIpv4Cidr(route.sourceNetworkCidr) &&
      containsIpv4(parseIpv4Cidr(route.sourceNetworkCidr)!, attachedNetworks[route.networkName].IPAddress!)),
  );
}
