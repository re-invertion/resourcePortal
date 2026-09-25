import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  DEFAULT_BLOCKED_IPV4_CIDRS,
  DEFAULT_BLOCKED_IPV6_CIDRS,
} from "./network-egress.constants";
import type { NetworkEgressPolicySnapshot } from "./network-egress.types";

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

export type TenantWorkload = {
  containerId: string;
  appGroupId: string;
  ipv4?: string;
  ipv6?: string;
};

export const DEFAULT_EGRESS_POLICY: NetworkEgressPolicySnapshot = {
  version: 2,
  enabled: true,
  revision: 0,
  blockedIpv4Cidrs: [...DEFAULT_BLOCKED_IPV4_CIDRS],
  blockedIpv6Cidrs: [...DEFAULT_BLOCKED_IPV6_CIDRS],
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
    workloads.push({ containerId, appGroupId, ipv4, ipv6 });
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
    const source = family === 4 ? workload.ipv4 : workload.ipv6;
    if (!source || isIP(source) !== family) continue;
    const sourceCidr = `${source}/${family === 4 ? 32 : 128}`;
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
    item.version === 2 &&
    typeof item.enabled === "boolean" &&
    Number.isInteger(item.revision) &&
    Array.isArray(item.blockedIpv4Cidrs) &&
    item.blockedIpv4Cidrs.every((cidr) => typeof cidr === "string") &&
    Array.isArray(item.blockedIpv6Cidrs) &&
    item.blockedIpv6Cidrs.every((cidr) => typeof cidr === "string")
  );
}
