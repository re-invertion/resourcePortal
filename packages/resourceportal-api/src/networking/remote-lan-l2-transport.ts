import { createHash } from "node:crypto";
import { parseIpv4Cidr } from "./network-addressing";

const safeDevice = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;
function ipv4Int(value: string): number {
  const parts = value.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Command = readonly [binary: "ip", args: readonly string[]];

export type RemoteLanTunnel = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  serverTunnelAddress: string;
  clientTunnelAddress: string;
  interface: "wg0" | "rp-gate";
  side: "resourceportal" | "gate";
};

/**
 * Deterministic GRETAP-on-WireGuard underlay command plan.
 * The RP and remote Gate produce the same GRE key, with inverse local/remote
 * addresses. Linux bridging and DHCP are deliberately NOT implied by setup.
 * Callers must separately verify tenant isolation and namespace ownership.
 */
export function gretapSetupCommands(tunnel: RemoteLanTunnel): Command[] {
  if (![tunnel.attachmentId, tunnel.tenantId, tunnel.gateId].every(v => uuid.test(v)))
    throw new Error("Invalid remote LAN tunnel identity");
  if (!safeDevice.test(tunnel.interface) ||
      (tunnel.side === "gate" && tunnel.interface !== "rp-gate") ||
      (tunnel.side === "resourceportal" && tunnel.interface !== "wg0"))
    throw new Error("Remote LAN must run inside the authenticated Gate tunnel namespace");
  const server = parseIpv4Cidr(tunnel.serverTunnelAddress);
  const client = parseIpv4Cidr(tunnel.clientTunnelAddress);
  // Gate tunnel addresses are allocated as a matched /30 pair by
  // nextAvailableGateTunnel(). The GRETAP outer endpoint needs the host
  // address, not parseIpv4Cidr().normalized (which is the network address).
  const serverIp = tunnel.serverTunnelAddress.split("/")[0];
  const clientIp = tunnel.clientTunnelAddress.split("/")[0];
  if (!server || !client || server.prefix !== 30 || client.prefix !== 30 ||
      server.network !== client.network || serverIp === clientIp ||
      !serverIp || !clientIp ||
      [server.network, server.broadcast].includes(ipv4Int(serverIp)) ||
      [client.network, client.broadcast].includes(ipv4Int(clientIp)))
    throw new Error("Invalid WireGuard /30 underlay pair");
  const digest = createHash("sha256")
    .update(tunnel.tenantId + ":" + tunnel.gateId + ":" + tunnel.attachmentId)
    .digest();
  const name = "rp-l2-" + digest.subarray(0, 4).toString("hex");
  // GRE key is scoped to the mutually authenticated WireGuard peer.
  const key = ((digest.readUInt32BE(4) % 4294967295) + 1).toString();
  const local = tunnel.side === "gate" ? clientIp : serverIp;
  const remote = tunnel.side === "gate" ? serverIp : clientIp;
  return [
    ["ip", ["link", "add", name, "type", "gretap",
      "local", local, "remote", remote, "key", key,
      "dev", tunnel.interface, "ttl", "64"]],
    ["ip", ["link", "set", "dev", name, "mtu", "1280", "up"]],
  ];
}
