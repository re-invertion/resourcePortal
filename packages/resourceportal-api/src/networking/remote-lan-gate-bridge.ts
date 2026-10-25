import {createHash} from "node:crypto";
import type {ManagedUplinkMode, ManagedUplinkObservation} from "./remote-lan-managed-uplink";
import {assertSafeGateLanInterface, type IpAddressSnapshot, type IpLinkSnapshot, type IpRouteSnapshot} from "./remote-lan-gate-preflight";
import {gretapSetupCommands, type RemoteLanTunnel} from "./remote-lan-l2-transport";

export type GateLanBridge = {
  gateId: string;
  tenantId: string;
  attachmentId: string;
  lanDevice: string;
  tunnel: RemoteLanTunnel;
  uplinkMode?: ManagedUplinkMode;
  managedObservation?: ManagedUplinkObservation;
};
type IpCommand = readonly [binary: "ip" | "bridge", args: readonly string[]];
const ifname = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;

/** Stable shared bridge for all applications using one Gate LAN handoff port. */
export function gateLanBridgeName(gateId: string, lanDevice: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(gateId) || !ifname.test(lanDevice))
    throw new Error("Invalid Gate LAN identity");
  return "rp-gb-" + createHash("sha256")
    .update(gateId + ":" + lanDevice).digest("hex").slice(0,8);
}

/**
 * No implicit migration of existing management NICs. A bridge may only adopt
 * a dedicated unnumbered port. An existing bridge is accepted when the
 * alias matches this exact Gate+physical interface ownership assertion.
 */
export function gateLanBridgePlan(
  input: GateLanBridge,
  links: readonly IpLinkSnapshot[],
  addresses: readonly IpAddressSnapshot[],
  routes: readonly IpRouteSnapshot[],
): IpCommand[] {
  if(input.tunnel.gateId !== input.gateId || input.tunnel.tenantId !== input.tenantId ||
     input.tunnel.attachmentId !== input.attachmentId || input.tunnel.side !== "gate")
    throw new Error("Cross-Gate, cross-tenant or cross-application L2 bridge is forbidden");
  const bridge = gateLanBridgeName(input.gateId,input.lanDevice);
  const alias = "rp-lan:" + input.gateId + ":" + input.lanDevice;
  const existing = links.find(link => link.ifname === bridge);
  const managed = input.uplinkMode === "ManagedSharedUplink";
  if(input.uplinkMode && !["ManagedSharedUplink","DedicatedUnnumbered"].includes(input.uplinkMode))
    throw new Error("Unsupported Gate uplink mode");
  if(managed) {
    const observed = input.managedObservation;
    if(!observed || observed.protocol!==1 || observed.state!=="Ready" ||
       observed.gateId!==input.gateId || observed.bridge!==bridge ||
       observed.physicalInterface!==input.lanDevice ||
       !Number.isFinite(Date.parse(observed.observedAt)) ||
       Math.abs(Date.now()-Date.parse(observed.observedAt))>60_000)
      throw new Error("Managed uplink requires fresh Gate-owned Ready observation");
    if(!existing) throw new Error("Managed bridge must be prepared independently from attachments");
  }
  const lanLink = links.find(link => link.ifname === input.lanDevice);
  if(existing) {
    if(existing.linkinfo?.info_kind !== "bridge" || existing.ifalias !== alias ||
      lanLink?.master !== bridge)
      throw new Error("Unowned or inconsistent existing Gate LAN bridge");
    // Managed mode may hold management IP on the bridge, never on the port.
    if(addresses.find(a=>a.ifname===input.lanDevice)?.addr_info?.some(
      a=>a.family==="inet"||a.family==="inet6") ||
      routes.some(r=>r.dev===input.lanDevice&&[ "default","0.0.0.0/0","::/0" ].includes(r.dst??"")))
      throw new Error("Gate LAN handoff must not carry management IP or default route");
  } else {
    assertSafeGateLanInterface(input.lanDevice,links,addresses,routes);
  }
  const tunnelCommands = gretapSetupCommands(input.tunnel);
  const tunnelDev = tunnelCommands[0][1][2];
  if(links.some(link=>link.ifname===tunnelDev)) throw new Error("Existing L2 tunnel requires explicit reconciliation");
  const commands: IpCommand[] = [];
  if(!existing) {
    commands.push(
      ["ip",["link","add",bridge,"type","bridge","stp_state","1","vlan_filtering","1","mcast_snooping","0"]],
      ["ip",["link","set","dev",bridge,"alias",alias]],
      ["ip",["link","set","dev",input.lanDevice,"master",bridge]],
      ["ip",["link","set","dev",bridge,"up"]],
    );
  }
  commands.push(...tunnelCommands);
  commands.push(
    ["ip",["link","set","dev",tunnelDev,"master",bridge]],
    ["bridge",["link","set","dev",tunnelDev,"isolated","on","hairpin","off"]],
  );
  return commands;
}

/**
 * Cleanup is allowed only for a Gate-owned bridge and a known RP tunnel.
 * The management NIC and any unrelated tenant interfaces are untouched.
 */
export function gateLanBridgeCleanup(
  input: GateLanBridge,
  links: readonly IpLinkSnapshot[],
  remainingAttachmentCount: number,
): IpCommand[] {
  if(!Number.isSafeInteger(remainingAttachmentCount) || remainingAttachmentCount<0)
    throw new Error("Invalid remaining attachment count");
  if(input.tunnel.gateId!==input.gateId||input.tunnel.tenantId!==input.tenantId||
      input.tunnel.attachmentId!==input.attachmentId||input.tunnel.side!=="gate")
    throw new Error("Unowned Gate tunnel cleanup");
  const bridge = gateLanBridgeName(input.gateId,input.lanDevice);
  const existing=links.find(link=>link.ifname===bridge);
  if(!existing||existing.ifalias!=="rp-lan:"+input.gateId+":"+input.lanDevice||
      existing.linkinfo?.info_kind!=="bridge")
    throw new Error("Refusing cleanup of an unowned Gate bridge");
  const dev=gretapSetupCommands(input.tunnel)[0][1][2];
  if(links.some(link=>link.ifname===dev&&link.master!==bridge))
    throw new Error("RP tunnel no longer belongs to expected bridge");
  // Revocation must remain possible after a LAN observation goes stale or
  // the management bridge is degraded. The kernel bridge's RP-owned alias
  // and tunnel's physical membership are the cleanup authorization anchors.
  if(input.uplinkMode === "ManagedSharedUplink" && input.managedObservation &&
     (input.managedObservation.gateId!==input.gateId ||
      input.managedObservation.bridge!==bridge))
    throw new Error("Managed bridge cleanup has inconsistent ownership");
  const commands:IpCommand[]=[["ip",["link","delete",dev]]];
  if(remainingAttachmentCount===0 && input.uplinkMode!=="ManagedSharedUplink") {
    // The caller must compare remaining desired state to observed bridge ports.
    // Unexpected bridge ports always block teardown.
    const children=links.filter(link=>link.master===bridge&&link.ifname!==dev);
    if(children.length!==1||children[0]?.ifname!==input.lanDevice)
      throw new Error("Unexpected ports on Gate LAN bridge");
    commands.push(["ip",["link","set","dev",input.lanDevice,"nomaster"]]);
    commands.push(["ip",["link","delete",bridge]]);
  }
  return commands;
}
