import { createHash } from "node:crypto";
import { containsIpv4, parseIpv4Cidr } from "./network-addressing";

export type AppL2Tunnel = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  appOverlayIp: string;
  gatewayOverlayIp: string;
  overlayCidr: string;
  overlayInterface: string;
  macAddress: string;
  side: "app" | "gateway";
};
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validIfname = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;
const validMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
type IpCommand = readonly [binary: "ip", args: readonly string[]];

/**
 * RP app <-> RP Gate gateway L2 transport over a tenant-only Swarm overlay.
 * No Docker overlay bridge is modified. The app endpoint is injected inside
 * its own network namespace by a separately authorized host-side controller.
 * It receives a DHCP address from the remote LAN; Docker IPAM is never used.
 */
export function appGretapCommands(input: AppL2Tunnel): IpCommand[] {
  if (![input.attachmentId, input.tenantId, input.gateId].every(x => validUuid.test(x)))
    throw new Error("Invalid application L2 attachment identity");
  const cidr = parseIpv4Cidr(input.overlayCidr);
  if (!cidr || cidr.prefix > 30 || cidr.prefix < 8 ||
      !containsIpv4(cidr, input.appOverlayIp) || !containsIpv4(cidr, input.gatewayOverlayIp) ||
      input.appOverlayIp === input.gatewayOverlayIp ||
      !validIfname.test(input.overlayInterface) ||
      ["lo","docker0","wg0","rp-gate"].includes(input.overlayInterface))
    throw new Error("L2 tunnel addresses must belong to the same authorized tenant overlay");
  if (!validMac.test(input.macAddress)) throw new Error("Invalid application MAC");
  const macFirst = Number.parseInt(input.macAddress.slice(0,2),16);
  if ((macFirst & 3) !== 2) throw new Error("Application MAC must be locally administered unicast");
  const identity = createHash("sha256").update(
    [input.tenantId, input.gateId, input.attachmentId].join(":"), "utf8",
  ).digest();
  const ifname = "rp-a-" + identity.subarray(0,4).toString("hex");
  const key = ((identity.readUInt32BE(8) % 4294967295) + 1).toString(10);
  const local = input.side === "app" ? input.appOverlayIp : input.gatewayOverlayIp;
  const remote = input.side === "app" ? input.gatewayOverlayIp : input.appOverlayIp;
  const commands: IpCommand[] = [
    ["ip",["link","add",ifname,"type","gretap",
      "local",local,"remote",remote,"key",key,"dev",input.overlayInterface,"ttl","64"]],
    ["ip",["link","set","dev",ifname,"mtu","1180"]],
  ];
  if (input.side === "app") {
    commands.push(["ip",["link","set","dev",ifname,"address",input.macAddress]]);
  }
  commands.push(["ip",["link","set","dev",ifname,"up"]]);
  return commands;
}

/** Do not disconnect Docker overlay or the app's default route on teardown. */
export function appGretapCleanupCommands(input: AppL2Tunnel): IpCommand[] {
  const cmd = appGretapCommands(input)[0][1];
  return [["ip",["link","delete",cmd[2]]]];
}

/** Only RP-owned attachment endpoints may join the per-attachment bridge. */
export function gatewayL2BridgeCommands(input: AppL2Tunnel): IpCommand[] {
  if (input.side !== "gateway") throw new Error("L2 bridge belongs only to the authenticated RP gateway");
  const appDev = appGretapCommands(input)[0][1][2];
  const bridge = "rp-b-" + appDev.slice(5);
  // The separate Gate-side Ethernet-over-WireGuard endpoint uses the same
  // attachment identity; validation runs in gretapSetupCommands().
  const wanDev = "rp-l2-" + createHash("sha256")
    .update([input.tenantId,input.gateId,input.attachmentId].join(":")).digest().subarray(0,4).toString("hex");
  return [
    ["ip",["link","add",bridge,"type","bridge","stp_state","1"]],
    ["ip",["link","set","dev",appDev,"master",bridge]],
    ["ip",["link","set","dev",wanDev,"master",bridge]],
    ["ip",["link","set","dev",bridge,"up"]],
  ];
}
