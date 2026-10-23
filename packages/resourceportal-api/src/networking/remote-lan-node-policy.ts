import { containsIpv4, parseIpv4Cidr } from "./network-addressing";
import { appGretapCommands, type AppL2Tunnel } from "./remote-lan-app-dataplane";

/**
 * Versioned, least-privilege snapshot for a node-local Swarm attachment agent.
 * Unlike Site VPN, no LAN routes may be injected into tenant containers.
 */
export type NodeLanAttachment = {
  attachmentId: string;
  tenantId: string;
  singleAppId: string;
  gateId: string;
  networkName: string;
  overlayCidr: string;
  lanCidr: string;
  gatewayOverlayIp: string;
  macAddress: string;
};
export type TenantContainer = {
  Id?: string;
  State?: { Pid?: number; Running?: boolean };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
};
export type NodeLanTarget = { pid: number; id: string; attachment: NodeLanAttachment; tunnel: AppL2Tunnel };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NETWORK = /^rp-network-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/** Throws on any stale, ambiguous or cross-tenant desired-state record. */
export function validateNodeLanSnapshot(input: unknown): NodeLanAttachment[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid remote LAN node snapshot");
  const value = input as { version?: unknown; attachments?: unknown };
  if (value.version !== 1 || !Array.isArray(value.attachments) || value.attachments.length > 512)
    throw new Error("Unsupported remote LAN node snapshot");
  const apps = new Set<string>();
  const result: NodeLanAttachment[] = [];
  for (const candidate of value.attachments) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Invalid remote LAN node attachment");
    const item = candidate as NodeLanAttachment;
    if (![item.attachmentId, item.tenantId, item.singleAppId, item.gateId].every(id => typeof id === "string" && UUID.test(id)) ||
        typeof item.networkName !== "string" || !NETWORK.test(item.networkName) ||
        typeof item.overlayCidr !== "string" || typeof item.gatewayOverlayIp !== "string" ||
        typeof item.macAddress !== "string" || !MAC.test(item.macAddress) ||
        (Number.parseInt(item.macAddress.slice(0, 2), 16) & 3) !== 2)
      throw new Error("Invalid remote LAN identity");
    const cidr = parseIpv4Cidr(item.overlayCidr);
    const gateway = parseIpv4Cidr(item.gatewayOverlayIp + "/32");
    const lan = typeof item.lanCidr === "string" ? parseIpv4Cidr(item.lanCidr) : null;
    if (!cidr || cidr.prefix < 8 || cidr.prefix > 30 || !gateway ||
        !lan || lan.prefix < 16 || lan.prefix > 30 || lan.normalized !== item.lanCidr ||
        !containsIpv4(cidr, item.gatewayOverlayIp) ||
        gateway.network === cidr.network || gateway.network === cidr.broadcast)
      throw new Error("Invalid remote LAN overlay address");
    const appKey = item.tenantId + ":" + item.singleAppId;
    if (apps.has(appKey)) throw new Error("More than one LAN attachment for the same application");
    apps.add(appKey);
    result.push(item);
  }
  return result;
}

/**
 * Requires the actual Docker application labels and the exact attached
 * tenant network. Never infer authorization from a service name or IP alone.
 * Do not select more than one task for a single attached application.
 */
export function selectNodeLanTargets(
  policy: NodeLanAttachment[], containers: readonly TenantContainer[],
): NodeLanTarget[] {
  const matches: NodeLanTarget[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    const labels = container.Config?.Labels ?? {};
    if (labels["resourceportal.workload"] !== "tenant" ||
        !container.State?.Running || !Number.isSafeInteger(container.State.Pid) ||
        !container.State.Pid || container.State.Pid < 2 ||
        !/^[0-9a-f]{64}$/i.test(container.Id ?? "")) continue;
    for (const attachment of policy) {
      if (labels["resourceportal.tenant-id"] !== attachment.tenantId ||
          labels["resourceportal.single-app-id"] !== attachment.singleAppId) continue;
      const ip = container.NetworkSettings?.Networks?.[attachment.networkName]?.IPAddress;
      const overlay = parseIpv4Cidr(attachment.overlayCidr);
      if (!ip || !overlay || !containsIpv4(overlay, ip) || ip === attachment.gatewayOverlayIp)
        continue;
      const selectedKey = attachment.tenantId + ":" + attachment.singleAppId;
      if (seen.has(selectedKey)) throw new Error("Ambiguous Swarm application replicas for LAN Attachment");
      seen.add(selectedKey);
      // The host-side node agent finds the correct device in this namespace
      // by its observed overlay source address, never by a guess like eth0.
      matches.push({
        id: container.Id!, pid: container.State.Pid,
        attachment,
        tunnel: {
          attachmentId: attachment.attachmentId,
          tenantId: attachment.tenantId,
          gateId: attachment.gateId,
          appOverlayIp: ip,
          gatewayOverlayIp: attachment.gatewayOverlayIp,
          overlayCidr: attachment.overlayCidr,
          overlayInterface: "__RESOLVE_FROM_NAMESPACE__",
          macAddress: attachment.macAddress,
          side: "app",
        },
      });
    }
  }
  return matches;
}

/**
 * A container PID alone is not a dataplane authorization. A changed Gate
 * endpoint, MAC, subnet or overlay source must revoke the old tunnel and DHCP
 * client before the new grant is installed.
 */
export function sameNodeLanTarget(previous: NodeLanTarget, desired: NodeLanTarget): boolean {
  const a = previous.attachment;
  const b = desired.attachment;
  const x = previous.tunnel;
  const y = desired.tunnel;
  return previous.id === desired.id && previous.pid === desired.pid &&
    a.attachmentId === b.attachmentId && a.tenantId === b.tenantId &&
    a.singleAppId === b.singleAppId && a.gateId === b.gateId &&
    a.networkName === b.networkName && a.overlayCidr === b.overlayCidr &&
    a.lanCidr === b.lanCidr && a.gatewayOverlayIp === b.gatewayOverlayIp &&
    a.macAddress === b.macAddress &&
    x.appOverlayIp === y.appOverlayIp &&
    x.gatewayOverlayIp === y.gatewayOverlayIp &&
    x.overlayCidr === y.overlayCidr && x.macAddress === y.macAddress &&
    x.tenantId === y.tenantId && x.gateId === y.gateId &&
    x.attachmentId === y.attachmentId && x.side === y.side;
}

/** Actual interface resolution is verified against the task's netns. */
export function nodeLanCommands(target: NodeLanTarget, overlayInterface: string) {
  return appGretapCommands({ ...target.tunnel, overlayInterface });
}
