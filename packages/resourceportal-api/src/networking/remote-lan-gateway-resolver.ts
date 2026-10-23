import { containsIpv4, parseIpv4Cidr } from "./network-addressing";
import type { GateRuntimeConfig } from "./gate-runtime.types";
import type { GatewayL2Input } from "./remote-lan-gateway-plan";

export type GatewayInterface = { name: string; address: string };
const SERVICE = /^rp_[a-zA-Z0-9_]+$/;
const IFACE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;

/**
 * Only a single live task on the tenant-owned overlay can receive an L2
 * connection. The gateway refuses split/mismatched network selections.
 */
export function planGatewayRuntimeAttachments(
  config: GateRuntimeConfig,
  interfaces: readonly GatewayInterface[],
  tasksByService: ReadonlyMap<string, readonly string[]>,
): GatewayL2Input[] {
  const inputs: GatewayL2Input[] = [];
  const knownApps = new Set<string>();
  const knownIds = new Set<string>();
  for (const item of config.remoteLanAttachments ?? []) {
    if (item.gateId !== config.gateId || !SERVICE.test(item.serviceName) ||
        typeof item.overlayCidr !== "string" ||
        !config.rpOverlayCidrs?.includes(item.overlayCidr))
      throw new Error("Untrusted gateway LAN attachment origin");
    const cidr = parseIpv4Cidr(item.overlayCidr);
    if (!cidr || cidr.prefix < 8 || cidr.prefix > 30)
      throw new Error("Invalid gateway LAN overlay subnet");
    const matches = interfaces.filter(net =>
      IFACE.test(net.name) && containsIpv4(cidr, net.address));
    if (matches.length !== 1) throw new Error("Ambiguous or missing Gate overlay interface");
    const [gateway] = matches;
    const peers = [...new Set(tasksByService.get(item.serviceName) ?? [])]
      .filter(ip => containsIpv4(cidr, ip) && ip !== gateway.address);
    if (peers.length !== 1) throw new Error("LAN attachment requires exactly one running app task");
    const key = item.tenantId + ":" + item.singleAppId;
    if (knownApps.has(key) || knownIds.has(item.attachmentId))
      throw new Error("Duplicate gateway LAN attachment identity");
    knownApps.add(key);
    knownIds.add(item.attachmentId);
    // The model gates MAC and /30 validity before any command is executed.
    inputs.push({
      app: {
        side: "gateway",
        attachmentId: item.attachmentId,
        tenantId: item.tenantId,
        gateId: item.gateId,
        appOverlayIp: peers[0],
        gatewayOverlayIp: gateway.address,
        overlayCidr: item.overlayCidr,
        overlayInterface: gateway.name,
        macAddress: item.macAddress,
      },
      wireguard: {
        side: "resourceportal",
        attachmentId: item.attachmentId,
        tenantId: item.tenantId,
        gateId: item.gateId,
        serverTunnelAddress: config.serverTunnelAddress,
        clientTunnelAddress: config.clientTunnelAddress,
        interface: "wg0",
      },
    });
  }
  return inputs;
}
