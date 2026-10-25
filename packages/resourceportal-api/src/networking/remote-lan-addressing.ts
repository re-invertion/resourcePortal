import {containsIpv4, parseIpv4Cidr} from "./network-addressing";
import {createHash} from "node:crypto";
import {managedBridgeName} from "./remote-lan-managed-uplink";

export type LanAddressMode = "DHCP" | "Static";
export type LanUplinkMode = "DedicatedUnnumbered" | "ManagedSharedUplink";
export type LanIpSettings = {
  addressMode: LanAddressMode;
  lanCidr: string;
  staticAddress: string | null;
  staticGateway: string | null;
};
export type LanAddressRequest = {
  addressMode?: string;
  lanCidr: string;
  staticAddress?: string | null;
  staticGateway?: string | null;
};
function ip(value: string):number | null {
  const parsed=parseIpv4Cidr(value+"/32");
  return parsed ? parsed.network : null;
}
export function normalizeLanAddress(
  input:LanAddressRequest, reserved: readonly string[] = [],
):LanIpSettings {
  const network=parseIpv4Cidr(input.lanCidr);
  if(!network||network.prefix<16||network.prefix>30||
    network.normalized!==input.lanCidr) throw new Error("Invalid canonical customer LAN subnet");
  const mode=input.addressMode??"DHCP";
  if(mode!=="Static"&&mode!=="DHCP")throw new Error("Unsupported LAN addressing mode");
  if(mode==="DHCP") {
    if(input.staticAddress!=null||input.staticGateway!=null)
      throw new Error("DHCP attachments cannot carry static address or gateway");
    return {addressMode:"DHCP",lanCidr:network.normalized,staticAddress:null,staticGateway:null};
  }
  if(!input.staticAddress||!input.staticGateway)
    throw new Error("Static LAN requires both IPv4 address and gateway");
  const address=parseIpv4Cidr(input.staticAddress);
  const host=ip(input.staticAddress.split("/")[0]);
  const gateway=ip(input.staticGateway);
  if(!address||host===null||gateway===null||
    address.prefix!==network.prefix||
    address.normalized!==network.normalized||
    !containsIpv4(network,input.staticGateway)||
    host===network.network||host===network.broadcast||
    gateway===network.network||gateway===network.broadcast||host===gateway)
    throw new Error("Static IPv4 address/gateway must be distinct usable LAN hosts");
  if(!input.staticAddress.endsWith("/"+network.prefix)||
     input.staticAddress.split("/")[0].split(".").some(x=>x.length>1&&x.startsWith("0"))||
     input.staticGateway.split(".").some(x=>x.length>1&&x.startsWith("0")))
    throw new Error("Static IP settings must use canonical IPv4 notation");
  if(reserved.includes(input.staticAddress.split("/")[0])||
     reserved.includes(input.staticGateway)) throw new Error("Static IPv4 address conflicts with reserved LAN resources");
  return {addressMode:"Static",lanCidr:network.normalized,
    staticAddress:input.staticAddress,staticGateway:input.staticGateway};
}
/**
 * Gate observations are machine-authenticated and versioned. In managed mode
 * a tenant-submitted expected subnet is never a substitute for fresh evidence.
 */
export type GateLanObservation = {
  protocol:1;gateId:string;physicalInterface:string;bridge:string;
  networkCidr:string;gateway:string;state:"Ready";
  observedAt:string;agentVersion:string;segmentId:string;
};
export function verifiedManagedLan(
  gateId:string,interfaceName:string,
  observed:unknown,reportedAt:Date|null,now=Date.now(),
): GateLanObservation {
  const o=observed as Partial<GateLanObservation>|null;
  if(!o||typeof o!=="object"||o.protocol!==1||o.state!=="Ready"||
      o.gateId!==gateId||o.physicalInterface!==interfaceName||
      typeof o.observedAt!=="string"||
      typeof o.networkCidr!=="string"||typeof o.gateway!=="string"||
      typeof o.bridge!=="string"||typeof o.segmentId!=="string"||
      typeof o.agentVersion!=="string"||!o.agentVersion.startsWith("gate-l2-v2")||
      !/^[0-9a-f]{24}$/.test(o.segmentId)||
      !/^rp-gb-[0-9a-f]{8}$/.test(o.bridge)||
      !reportedAt||Math.abs(now-reportedAt.getTime())>60_000||
      !Number.isFinite(Date.parse(o.observedAt))||
      Math.abs(now-Date.parse(o.observedAt))>60_000)
    throw new Error("Missing or stale authenticated Gate LAN observation");
  const cidr=parseIpv4Cidr(o.networkCidr);
  if(!cidr||cidr.normalized!==o.networkCidr||
    !containsIpv4(cidr,o.gateway))throw new Error("Invalid observed Gate network");
  const bridge=managedBridgeName(gateId,interfaceName);
  const segmentId=createHash("sha256").update(gateId+":"+interfaceName+":"+o.networkCidr)
    .digest("hex").slice(0,24);
  if(o.bridge!==bridge||o.segmentId!==segmentId)
    throw new Error("Managed observation bridge/segment identity mismatch");
  return o as GateLanObservation;
}
