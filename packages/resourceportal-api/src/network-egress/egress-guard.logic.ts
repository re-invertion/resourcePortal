import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  DEFAULT_BLOCKED_IPV4_CIDRS,
  DEFAULT_BLOCKED_IPV6_CIDRS,
} from "./network-egress.constants";
import type {
  EgressProtocol,
  NetworkEgressPolicySnapshot,
} from "./network-egress.types";

export type DockerContainerInspect = {
  Id?: string;
  Config?: { Labels?: Record<string, string> | null } | null;
};

export type DockerGatewayNetworkInspect = {
  Containers?: Record<
    string,
    { IPv4Address?: string; IPv6Address?: string; Name?: string }
  > | null;
};

export type RuntimeInternalPortExposure = {
  publishedPort: number;
  protocol: "tcp" | "udp";
};

export type TenantWorkload = {
  containerId: string;
  appGroupId: string;
  ipv4?: string;
  ipv6?: string;
  internalPortExposures: RuntimeInternalPortExposure[];
};

export const DEFAULT_EGRESS_POLICY: NetworkEgressPolicySnapshot = {
  version: 1,
  enabled: true,
  revision: 0,
  blockedIpv4Cidrs: [...DEFAULT_BLOCKED_IPV4_CIDRS],
  blockedIpv6Cidrs: [...DEFAULT_BLOCKED_IPV6_CIDRS],
  internalNetworkCidrs: [],
  privilegedAppGroupIds: [],
  rules: [],
};

export function decodeEgressPolicy(
  encoded: string | undefined,
): NetworkEgressPolicySnapshot {
  if (!encoded) return DEFAULT_EGRESS_POLICY;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!isPolicy(value)) return DEFAULT_EGRESS_POLICY;
    return value;
  } catch {
    return DEFAULT_EGRESS_POLICY;
  }
}

export function encodeEgressPolicy(policy: NetworkEgressPolicySnapshot) {
  return Buffer.from(JSON.stringify(policy), "utf8").toString("base64");
}

export function egressPolicyDigest(policy: NetworkEgressPolicySnapshot) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function tenantWorkloads(
  containers: DockerContainerInspect[],
  gateway: DockerGatewayNetworkInspect,
): TenantWorkload[] {
  const gatewayContainers = gateway.Containers ?? {};
  const workloads: TenantWorkload[] = [];
  for (const container of containers) {
    const containerId = container.Id;
    if (!containerId) continue;
    const appGroupId = appGroupIdFromLabels(container.Config?.Labels ?? {});
    if (!appGroupId) continue;
    const gatewayEntry = gatewayContainers[containerId];
    if (!gatewayEntry) continue;
    const ipv4 = stripPrefix(gatewayEntry.IPv4Address);
    const ipv6 = stripPrefix(gatewayEntry.IPv6Address);
    if (!ipv4 && !ipv6) continue;
    workloads.push({
      containerId,
      appGroupId,
      ipv4,
      ipv6,
      internalPortExposures: internalPortExposuresFromLabels(
        container.Config?.Labels ?? {},
      ),
    });
  }
  return workloads.sort((a, b) => a.containerId.localeCompare(b.containerId));
}

export function appGroupIdFromLabels(labels: Record<string, string>) {
  const explicit = labels["resourceportal.app-group-id"];
  if (isUuid(explicit)) return explicit.toLowerCase();

  const stack = labels["com.docker.stack.namespace"] ?? "";
  const match = /^rp_([0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})$/i.exec(
    stack,
  );
  if (!match?.[1]) return undefined;
  const candidate = match[1].replaceAll("_", "-").toLowerCase();
  return isUuid(candidate) ? candidate : undefined;
}

export function firewallRulesForWorkloads(
  policy: NetworkEgressPolicySnapshot,
  workloads: TenantWorkload[],
  family: 4 | 6,
) {
  if (!policy.enabled) return [] as string[][];
  const blocked = family === 4 ? policy.blockedIpv4Cidrs : policy.blockedIpv6Cidrs;
  const commands: string[][] = [];
  for (const workload of workloads) {
    if (policy.privilegedAppGroupIds.includes(workload.appGroupId)) continue;
    const source = family === 4 ? workload.ipv4 : workload.ipv6;
    if (!source || isIP(source) !== family) continue;
    const sourceCidr = `${source}/${family === 4 ? 32 : 128}`;
    for (const rule of policy.rules.filter(
      (item) => item.appGroupId === workload.appGroupId,
    )) {
      const destinationAddress = rule.destinationCidr.split("/")[0] ?? "";
      if (isIP(destinationAddress) !== family) continue;
      commands.push([
        "-s",
        sourceCidr,
        "-d",
        rule.destinationCidr,
        ...protocolArgs(rule.protocol, rule.port),
        "-j",
        "RETURN",
      ]);
    }
    for (const cidr of blocked) {
      commands.push([
        "-s",
        sourceCidr,
        "-d",
        cidr,
        "-j",
        "REJECT",
      ]);
    }
  }
  return commands;
}

export function internalPortExposuresFromLabels(
  labels: Record<string, string>,
): RuntimeInternalPortExposure[] {
  const encoded = labels["resourceportal.internal-port-exposures-b64"];
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const exposures: RuntimeInternalPortExposure[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const publishedPort = value.publishedPort;
      const protocol = value.protocol;
      if (
        typeof publishedPort === "number" &&
        Number.isInteger(publishedPort) &&
        publishedPort >= 1 &&
        publishedPort <= 65535 &&
        (protocol === "tcp" || protocol === "udp")
      ) {
        exposures.push({ publishedPort, protocol });
      }
    }
    return exposures;
  } catch {
    return [];
  }
}

export function runtimeInternalPortExposures(workloads: TenantWorkload[]) {
  const unique = new Map<string, RuntimeInternalPortExposure>();
  for (const workload of workloads) {
    for (const exposure of workload.internalPortExposures) {
      unique.set(`${exposure.protocol}:${exposure.publishedPort}`, exposure);
    }
  }
  return [...unique.values()].sort(
    (a, b) => a.publishedPort - b.publishedPort || a.protocol.localeCompare(b.protocol),
  );
}

export function internalPortFirewallRules(
  policy: NetworkEgressPolicySnapshot,
  workloads: TenantWorkload[],
  family: 4 | 6,
) {
  const allowedCidrs = policy.internalNetworkCidrs.filter((cidr) => {
    const address = cidr.split("/")[0] ?? "";
    return isIP(address) === family;
  });
  const privilegedSources = workloads
    .filter((workload) => policy.privilegedAppGroupIds.includes(workload.appGroupId))
    .map((workload) => (family === 4 ? workload.ipv4 : workload.ipv6))
    .filter((address): address is string => typeof address === "string" && isIP(address) === family)
    .map((address) => `${address}/${family === 4 ? 32 : 128}`);
  const allowedSources = [...new Set([...allowedCidrs, ...privilegedSources])];
  const rules: string[][] = [];
  for (const exposure of runtimeInternalPortExposures(workloads)) {
    for (const cidr of allowedSources) {
      rules.push([
        "-s",
        cidr,
        "-p",
        exposure.protocol,
        "-m",
        "conntrack",
        "--ctstate",
        "DNAT",
        "--ctorigdstport",
        String(exposure.publishedPort),
        "-j",
        "RETURN",
      ]);
    }
    rules.push([
      "-p",
      exposure.protocol,
      "-m",
      "conntrack",
      "--ctstate",
      "DNAT",
      "--ctorigdstport",
      String(exposure.publishedPort),
      "-j",
      "REJECT",
    ]);
  }
  return rules;
}

function protocolArgs(protocol: EgressProtocol, port: number) {
  if (protocol === "any") return [];
  return [
    "-p",
    protocol,
    ...(port > 0 ? ["--dport", String(port)] : []),
  ];
}

function stripPrefix(value: string | undefined) {
  if (!value) return undefined;
  const address = value.split("/")[0]?.trim();
  return address || undefined;
}

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function isPolicy(value: unknown): value is NetworkEgressPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NetworkEgressPolicySnapshot>;
  return (
    item.version === 1 &&
    typeof item.enabled === "boolean" &&
    Number.isInteger(item.revision) &&
    Array.isArray(item.blockedIpv4Cidrs) &&
    item.blockedIpv4Cidrs.every((cidr) => typeof cidr === "string") &&
    Array.isArray(item.blockedIpv6Cidrs) &&
    item.blockedIpv6Cidrs.every((cidr) => typeof cidr === "string") &&
    Array.isArray(item.internalNetworkCidrs) &&
    item.internalNetworkCidrs.every((cidr) => typeof cidr === "string") &&
    Array.isArray(item.privilegedAppGroupIds) &&
    item.privilegedAppGroupIds.every((id) => isUuid(id)) &&
    Array.isArray(item.rules) &&
    item.rules.every(
      (rule) =>
        Boolean(rule) &&
        typeof rule.id === "string" &&
        isUuid(rule.appGroupId) &&
        typeof rule.destinationCidr === "string" &&
        ["any", "tcp", "udp"].includes(rule.protocol) &&
        Number.isInteger(rule.port) &&
        rule.port >= 0 &&
        rule.port <= 65535,
    )
  );
}
