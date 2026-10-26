import { containsIpv4, parseIpv4Cidr } from "./network-addressing";
import { appGretapCommands, type AppL2Tunnel } from "./remote-lan-app-dataplane";
import {normalizeLanAddress} from "./remote-lan-addressing";

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
  configurationRevision?: number;
  addressMode?: "DHCP" | "Static";
  staticAddress?: string | null;
  staticGateway?: string | null;
  uplinkMode?: "DedicatedUnnumbered" | "ManagedSharedUplink";
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
    const address = normalizeLanAddress({
      lanCidr:item.lanCidr,addressMode:item.addressMode??"DHCP",
      staticAddress:item.staticAddress,staticGateway:item.staticGateway
    });
    if(address.addressMode==="Static" && item.uplinkMode!=="ManagedSharedUplink")
      throw new Error("Static address requires a verified managed Gate");
    if(item.configurationRevision!==undefined&&(!Number.isSafeInteger(item.configurationRevision)||item.configurationRevision<1))
      throw new Error("Invalid LAN configuration revision");
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
    (a.configurationRevision??1)===(b.configurationRevision??1) &&
    (a.addressMode??"DHCP") === (b.addressMode??"DHCP") &&
    (a.uplinkMode??"DedicatedUnnumbered") === (b.uplinkMode??"DedicatedUnnumbered") &&
    (a.staticAddress??null) === (b.staticAddress??null) &&
    (a.staticGateway??null) === (b.staticGateway??null) &&
    a.macAddress === b.macAddress &&
    x.appOverlayIp === y.appOverlayIp &&
    x.gatewayOverlayIp === y.gatewayOverlayIp &&
    x.overlayCidr === y.overlayCidr && x.macAddress === y.macAddress &&
    x.tenantId === y.tenantId && x.gateId === y.gateId &&
    x.attachmentId === y.attachmentId && x.side === y.side;
}


/**
 * Revoke stale endpoints independently so a foreign bridge on one endpoint
 * cannot prevent revocation of unrelated attachments. Keep failed entries
 * tracked for retry and stop reconciliation before granting replacements.
 */
export function revokeNodeLanEntries<T extends {
  target: NodeLanTarget;
  dhcp: { killed: boolean; pid?: number; exitCode: number | null; signalCode?: string | null } | null;
}>(
  managed: Map<string, T>,
  desired: ReadonlyMap<string, NodeLanTarget>,
  detach: (entry: T) => void,
  transportMatches?: (entry: T) => boolean,
): void {
  const failures: unknown[] = [];
  for (const [key, entry] of managed) {
    try {
      const updated = desired.get(key);
      const healthy = updated && sameNodeLanTarget(entry.target, updated) &&
        (entry.dhcp ? (!entry.dhcp.killed &&
          entry.dhcp.pid !== undefined && entry.dhcp.exitCode === null &&
          entry.dhcp.signalCode == null) :
          entry.target.attachment.addressMode === "Static");
      // The snapshot may already be current while a surviving GRETAP still
      // points at a previous Swarm Gateway task (or lost its RP MAC).
      if (healthy && (!transportMatches || transportMatches(entry))) continue;
      detach(entry);
      managed.delete(key);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "One or more LAN attachment revocations failed");
}

/** Actual interface resolution is verified against the task's netns. */
export function nodeLanCommands(target: NodeLanTarget, overlayInterface: string) {
  return appGretapCommands({ ...target.tunnel, overlayInterface });
}

/**
 * Static routes are installed only inside the target application namespace.
 * Its ordinary Docker default route is retained. Source-specific traffic from
 * the explicit static LAN address uses the customer-supplied Gateway, with no
 * host/Site VPN route added to RP or to other tenant namespaces.
 */
export function staticNodeLanCommands(target: NodeLanTarget,device:string) {
  const config=normalizeLanAddress({
    lanCidr:target.attachment.lanCidr,addressMode:target.attachment.addressMode,
    staticAddress:target.attachment.staticAddress,
    staticGateway:target.attachment.staticGateway
  });
  if(config.addressMode!=="Static"||!config.staticAddress||!config.staticGateway||
     target.attachment.uplinkMode!=="ManagedSharedUplink"||
     !/^rp-a-[0-9a-f]{8}$/.test(device))
    throw new Error("Static route requires authorized managed LAN endpoint");
  const source=config.staticAddress.split("/")[0];
  return [
    ["-4","address","replace",config.staticAddress,"dev",device],
    ["-4","route","replace","default","via",config.staticGateway,
      "dev",device,"table","20015"],
    ["-4","rule","add","pref","18015","from",source+"/32","lookup","20015"]
  ] as readonly (readonly string[])[];
}

/**
 * The app-side GRETAP is a standalone DHCP endpoint in the tenant netns.
 * Only the gateway-side endpoint is bridged. Never adopt or delete an
 * app-side link that has acquired a bridge/master, even if its alias matches.
 */
export type NodeLanLink = {
  ifname?: string;
  ifalias?: string;
  master?: string | number | null;
  address?: string;
  flags?: string[];
  linkinfo?: {
    info_kind?: string;
    info_data?: { local?: string; remote?: string };
  };
};
const appLinkName = /^rp-a-[0-9a-f]{8}$/;
const appLinkAlias = /^rp-lan:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertStandaloneGretap(link: NodeLanLink, device: string): void {
  if (link.ifname !== device || !appLinkName.test(device) ||
      link.linkinfo?.info_kind !== "gretap" || link.master != null)
    throw new Error("Refusing to alter foreign or bridged GRETAP in tenant namespace");
}

/** For adopting or revoking a fully configured attachment. */
export function assertOwnedNodeLanLink(link: NodeLanLink, device: string, attachmentId: string): void {
  assertStandaloneGretap(link, device);
  if (link.ifalias !== "rp-lan:" + attachmentId)
    throw new Error("Refusing to alter GRETAP with foreign attachment alias");
}

/**
 * An interface created by this process may not have received its alias if
 * setup failed midway. The caller must prove it successfully created it.
 */
export function assertCreatedNodeLanLink(link: NodeLanLink, device: string, attachmentId: string): void {
  assertStandaloneGretap(link, device);
  if (link.ifalias != null && link.ifalias !== "" &&
      link.ifalias !== "rp-lan:" + attachmentId)
    throw new Error("Refusing partial cleanup of GRETAP with foreign alias");
}

/**
 * A matching RP alias proves ownership, not correctness of the running
 * transport. Require the actual kernel GRETAP peer and RP-assigned MAC to
 * match the current authenticated Swarm policy.
 */
export function nodeLanTransportMatches(link: NodeLanLink, target: NodeLanTarget): boolean {
  return link.linkinfo?.info_data?.local === target.tunnel.appOverlayIp &&
    link.linkinfo?.info_data?.remote === target.tunnel.gatewayOverlayIp &&
    link.address?.toLowerCase() === target.attachment.macAddress.toLowerCase();
}

/**
 * Called before adopting an orphan from a previous node-agent task. Never
 * adopt an unverified DHCP lease or a GRETAP pointing at an old Gateway IP.
 * Only remove a standalone, correctly aliased RP-owned interface, after
 * safely removing any RP-owned Static source policy.
 *
 * Returns true only when an already configured Static link may be adopted.
 */
export function prepareNodeLanLinkForGrant(
  target: NodeLanTarget, device: string, observed: NodeLanLink | undefined,
  cleanupOldStatic: () => void, removeOwnedLink: () => void,
  staticConfigurationMatches: () => boolean,
): boolean {
  if (!observed) return false;
  assertOwnedNodeLanLink(observed, device, target.attachment.attachmentId);
  // An aligned GRETAP may still carry the previous DHCP address after an
  // agent restart. Adopt Static only with exact source rule, route and one
  // matching IPv4 address. Otherwise drop just this RP-owned interface.
  if (target.attachment.addressMode === "Static" &&
      nodeLanTransportMatches(observed, target) &&
      staticConfigurationMatches()) return true;
  cleanupOldStatic();
  removeOwnedLink();
  return false;
}

/** Reconcile only unbridged, RP-labelled orphan endpoints. */
export function shouldDeleteNodeLanOrphan(link: NodeLanLink, active: ReadonlySet<string>): boolean {
  if (!link.ifname || !appLinkName.test(link.ifname) ||
      !link.ifalias || !appLinkAlias.test(link.ifalias) ||
      active.has(link.ifname)) return false;
  assertStandaloneGretap(link, link.ifname);
  return true;
}


/**
 * A bridged/foreign orphan must not stop cleanup of other stale endpoints,
 * including those in later tenant namespaces. Collect every failure and
 * fail closed after attempting all independent revocations.
 */
export function sweepNodeLanOrphans(
  namespaces: readonly { pid: number; active: ReadonlySet<string>; protectedAliases?: ReadonlySet<string> }[],
  list: (pid: number) => readonly NodeLanLink[],
  remove: (pid: number, ifname: string) => void,
): void {
  const failures: unknown[] = [];
  for (const namespace of namespaces) {
    let candidates: readonly NodeLanLink[];
    try {
      candidates = list(namespace.pid);
    } catch (error) {
      failures.push(error);
      continue;
    }
    for (const link of candidates) {
      try {
        // A desired endpoint may be adopted after revocation; do not delete it
        // during the pre-grant sweep, even if another revocation failed.
        if (link.ifalias && namespace.protectedAliases?.has(link.ifalias)) continue;
        if (shouldDeleteNodeLanOrphan(link, namespace.active))
          remove(namespace.pid, link.ifname!);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "One or more LAN orphan revocations failed");
}


/**
 * Complete independent managed and orphan revocations before any new grant.
 * A failed bridged managed endpoint cannot block unrelated orphan cleanup,
 * but any failure still blocks the subsequent attachment phase.
 */
export function revokeNodeLanState<T extends {
  target: NodeLanTarget;
  device: string;
  dhcp: { killed: boolean; pid?: number; exitCode: number | null; signalCode?: string | null } | null;
}>(
  managed: Map<string, T>,
  desired: ReadonlyMap<string, NodeLanTarget>,
  pids: readonly number[],
  detach: (entry: T) => void,
  list: (pid: number) => readonly NodeLanLink[],
  remove: (pid: number, ifname: string) => void,
  transportMatches?: (entry: T) => boolean,
): void {
  const failures: unknown[] = [];
  try {
    revokeNodeLanEntries(managed, desired, detach, transportMatches);
  } catch (error) {
    failures.push(error);
  }
  const namespaces = [...new Set(pids)].map(pid => ({
    pid,
    active: new Set([...managed.values()].filter(item =>
      item.target.pid === pid).map(item => item.device)),
    protectedAliases: new Set([...desired.values()].filter(target =>
      target.pid === pid).map(target => "rp-lan:" + target.attachment.attachmentId)),
  }));
  try {
    sweepNodeLanOrphans(namespaces, list, remove);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "One or more LAN revocations failed; refusing new grants");
}
