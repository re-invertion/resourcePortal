import {createHash} from "node:crypto";
import type {IpLinkSnapshot, IpRouteSnapshot} from "./remote-lan-gate-preflight";
import {parseIpv4Cidr} from "./network-addressing";

/** The managed uplink is a separate Gate-owned host resource, NOT an attachment. */
export type ManagedUplinkMode = "DedicatedUnnumbered" | "ManagedSharedUplink";
export type UplinkState = "Unconfigured" | "Preflight" | "Preparing" | "Migrating" |
  "Verifying" | "Ready" | "Degraded" | "RollingBack" | "Failed";
export type ManagedUplinkObservation = {
  protocol: 1;
  gateId: string;
  segmentId: string;
  bridge: string;
  physicalInterface: string;
  networkCidr: string;
  prefix: number;
  netmask: string;
  gateway: string | null;
  discoveryMethod: "host-verified";
  observedAt: string;
  agentVersion: string;
  state: "Ready";
};
/** Snapshots are collected read-only by the Gate, never submitted by an app/user. */
export type ManagedUplinkSnapshot = {
  gateId: string;
  device: string;
  links: readonly IpLinkSnapshot[];
  addresses: readonly { ifname?: string; addr_info?: Array<{
    family?: string; local?: string; prefixlen?: number; scope?: string;
  }> }[];
  routes: readonly IpRouteSnapshot[];
  manager: "systemd-networkd" | "NetworkManager" | "dhcpcd" | "unknown" | "multiple";
  networkManagerOwnsDevice: boolean;
  checkpointVerified: boolean;
  watchdogArmed: boolean;
  rollbackTested: boolean;
  controlPlaneReachable: boolean;
  observedAt: string;
  agentVersion: string;
};
const devRe=/^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;
const gateRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function ipv4(value:string): number[] | undefined {
  if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return;
  const octets=value.split(".").map(Number);
  return octets.every(x=>x>=0&&x<=255) ? octets : undefined;
}
function mask(prefix:number):string {
  const value=prefix===0?0:(0xffffffff << (32-prefix))>>>0;
  return [24,16,8,0].map(n=>(value>>>n)&255).join(".");
}
export function managedBridgeName(gateId:string,device:string):string {
  if(!gateRe.test(gateId)||!devRe.test(device)) throw new Error("Invalid Gate uplink identity");
  return "rp-gb-"+createHash("sha256").update(gateId+":"+device).digest("hex").slice(0,8);
}
export type ManagedUplinkPreflightSnapshot = Omit<ManagedUplinkSnapshot,
  "checkpointVerified" | "watchdogArmed" | "rollbackTested" | "controlPlaneReachable"> & {
  /** Resolved by networkctl, not supplied by the tenant. */
  managedNetworkFile: string | null;
  ipv4DhcpOwned: boolean;
  competingNetworkManagers: readonly string[];
};
export type ManagedMigrationPreflight = {
  state: "Preflight";
  gateId: string;
  physicalInterface: string;
  bridge: string;
  existingHostIpv4: string;
  existingGateway: string;
  networkCidr: string;
  originalNetworkFile: string;
  requiresIndependentRollbackWatchdog: true;
  /** No action is authorized merely by obtaining a preflight. */
  canApply: false;
};
/**
 * Safe initial certification envelope: Debian systemd-networkd with DHCPv4,
 * one physical NIC, no global IPv6 management or foreign bridge memberships.
 * No mutation or link reconfiguration occurs here. A privileged installer must
 * independently checkpoint/arm a rollback service before any migration.
 */
export function preflightManagedUplink(
  input:ManagedUplinkPreflightSnapshot,now=Date.now(),
):ManagedMigrationPreflight {
  const bridge=managedBridgeName(input.gateId,input.device);
  if(!devRe.test(input.device)||
     !Number.isFinite(Date.parse(input.observedAt)) ||
     Math.abs(now-Date.parse(input.observedAt))>60_000)
    throw new Error("Invalid or stale managed uplink preflight");
  if(input.manager!=="systemd-networkd"||!input.networkManagerOwnsDevice||
     input.competingNetworkManagers.length!==0||
     !input.ipv4DhcpOwned||
     !input.managedNetworkFile ||
     !/^\/etc\/systemd\/network\/[a-zA-Z0-9_.-]+\.network$/.test(input.managedNetworkFile))
    throw new Error("Managed uplink requires a unique supported networkd DHCP configuration");
  const link=input.links.find(x=>x.ifname===input.device);
  if(!link||link.link_type!=="ether"||link.linkinfo?.info_kind||
     link.master||link.operstate!=="UP"||!Number.isSafeInteger(link.ifindex)||
     input.links.some(x=>x.ifname===bridge || x.master===input.device))
    throw new Error("Unsafe Ethernet uplink topology or existing foreign bridge");
  const addrs=input.addresses.find(x=>x.ifname===input.device)?.addr_info??[];
  if(addrs.some(x=>x.family==="inet6"&&x.scope!=="link"))
    throw new Error("IPv6 global management requires a certified migration");
  const ips=addrs.filter(x=>x.family==="inet");
  if(ips.length!==1||!ips[0].local||!ipv4(ips[0].local)||
      typeof ips[0].prefixlen!=="number" || !Number.isInteger(ips[0].prefixlen)||
      ips[0].prefixlen<16||ips[0].prefixlen>30)
    throw new Error("Missing or ambiguous DHCPv4 management address");
  const subnet=parseIpv4Cidr(ips[0].local+"/"+ips[0].prefixlen);
  if(!subnet)throw new Error("Invalid host management subnet");
  const routes=input.routes.filter(x=>x.dst==="default"||x.dst==="0.0.0.0/0");
  if(routes.length!==1||routes[0].dev!==input.device||!routes[0].gateway ||
      !ipv4(routes[0].gateway))
    throw new Error("Ambiguous or foreign management route");
  const gateway=parseIpv4Cidr(routes[0].gateway+"/"+ips[0].prefixlen);
  if(!gateway||subnet.network!==gateway.network)
    throw new Error("DHCP management gateway is off-link");
  const networkCidr=[24,16,8,0].map(n=>(subnet.network>>>n)&255).join(".")+
    "/"+ips[0].prefixlen;
  return {
    state:"Preflight",gateId:input.gateId,physicalInterface:input.device,bridge,
    existingHostIpv4:ips[0].local+"/"+ips[0].prefixlen,
    existingGateway:routes[0].gateway,networkCidr,
    originalNetworkFile:input.managedNetworkFile,
    requiresIndependentRollbackWatchdog:true,canApply:false
  };
}

/** Strict post-migration verification: no guessing prefixes or losing control plane. */
export function observeManagedUplink(input: ManagedUplinkSnapshot, now=Date.now()):ManagedUplinkObservation {
  const bridge=managedBridgeName(input.gateId,input.device);
  if(!Number.isFinite(now)||!input.observedAt||!Number.isFinite(Date.parse(input.observedAt))||
    Math.abs(now-Date.parse(input.observedAt))>60_000) throw new Error("Stale or invalid Gate LAN observation");
  if(input.manager!=="systemd-networkd"||!input.networkManagerOwnsDevice)
    throw new Error("Managed uplink requires verified single systemd-networkd ownership");
  if(!input.checkpointVerified||!input.watchdogArmed||!input.rollbackTested||!input.controlPlaneReachable)
    throw new Error("Managed uplink migration/rollback or control plane not verified");
  if(!/^gate-l2-[A-Za-z0-9.-]{1,40}$/.test(input.agentVersion))
    throw new Error("Unsupported Gate observation version");
  const uplink=input.links.find(x=>x.ifname===input.device);
  const br=input.links.find(x=>x.ifname===bridge);
  if(!uplink||uplink.link_type!=="ether"||uplink.operstate!=="UP"||
      uplink.master!==bridge||uplink.linkinfo?.info_kind)
    throw new Error("Managed uplink is not a bridged physical Ethernet port");
  if(!br||br.linkinfo?.info_kind!=="bridge"||
      br.ifalias!=="rp-lan:"+input.gateId+":"+input.device||
      br.operstate!=="UP") throw new Error("Unowned or down managed bridge");
  if(input.links.filter(x=>x.master===bridge&&x.ifname===input.device).length!==1 ||
      input.links.some(x=>x.master===bridge&&x.ifname!==input.device&&
        !/^rp-l2-[0-9a-f]{8}$/.test(x.ifname??"")))
    throw new Error("Unexpected managed bridge membership");
  if(input.addresses.find(x=>x.ifname===input.device)?.addr_info?.some(a=>a.family==="inet" || a.family==="inet6"))
    throw new Error("Physical interface retains a management address");
  const ipv4Addresses=(input.addresses.find(x=>x.ifname===bridge)?.addr_info??[])
    .filter(a=>a.family==="inet"&&a.scope!=="host");
  if(ipv4Addresses.length!==1) throw new Error("Managed bridge requires a unique observed IPv4 address");
  const address=ipv4Addresses[0];
  if(!address.local||!ipv4(address.local)||typeof address.prefixlen!=="number"||!Number.isInteger(address.prefixlen)||
      address.prefixlen<16||address.prefixlen>30)
    throw new Error("Ambiguous or unsafe observed LAN prefix");
  const cidr=parseIpv4Cidr(address.local+"/"+address.prefixlen);
  if(!cidr) throw new Error("Invalid observed LAN CIDR");
  const routes=input.routes.filter(r=>r.dst==="default"||r.dst==="0.0.0.0/0");
  if(routes.length!==1||routes[0].dev!==bridge||!routes[0].gateway ||
    !ipv4(routes[0].gateway)) throw new Error("Managed default route not present on bridge");
  if(input.routes.some(r=>r.dev===input.device))
    throw new Error("Physical port still owns routing");
  const gateway=routes[0].gateway;
  const gw=parseIpv4Cidr(gateway+"/"+address.prefixlen);
  if(!gw||gw.network!==cidr.network ||
     [cidr.network,cidr.broadcast].includes(
       (((ipv4(gateway)![0]<<24)|(ipv4(gateway)![1]<<16)|(ipv4(gateway)![2]<<8)|ipv4(gateway)![3])>>>0)))
    throw new Error("Default gateway does not belong to observed LAN");
  const base=address.local.split(".").map(Number);
  const network=cidr.network;
  const networkCidr=[24,16,8,0].map(n=>(network>>>n)&255).join(".")+"/"+address.prefixlen;
  if(base.every((v,i)=>v===Number(networkCidr.split("/")[0].split(".")[i])))
    throw new Error("Observed host address is network address");
  return {
    protocol:1,gateId:input.gateId,segmentId:createHash("sha256")
      .update(input.gateId+":"+input.device+":"+networkCidr).digest("hex").slice(0,24),
    bridge,physicalInterface:input.device,networkCidr,
    prefix:address.prefixlen,netmask:mask(address.prefixlen),gateway,
    discoveryMethod:"host-verified",observedAt:input.observedAt,
    agentVersion:input.agentVersion,state:"Ready"
  };
}