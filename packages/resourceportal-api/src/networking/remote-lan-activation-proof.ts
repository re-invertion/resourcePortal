import {containsIpv4,parseIpv4Cidr} from "./network-addressing";
import {normalizeLanAddress} from "./remote-lan-addressing";

const identity=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mac=/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const proofAge=30_000;
const clockSkew=5_000;
export type LanProofIdentity={
  attachmentId:string; tenantId:string; singleAppId:string; gateId:string;
  configurationRevision:number; macAddress:string; observedAtMs:number;
};
export type NodeLanProof=LanProofIdentity & {
  source:"node-agent"; taskContainerId:string; nodeTaskId:string; mode:"DHCP"|"Static";
  address:string; prefix:number; appLinkOwned:boolean; appLinkUp:boolean;
  overlayPeerMatched:boolean; dockerDefaultPreserved:boolean;
  dhcpServer?:string; leaseExpiresAtMs?:number;
  staticGateway?:string; sourcePolicyVerified?:boolean;
};
export type GateLanProof=LanProofIdentity & {
  source:"gate-agent"; gatewayTunnelOwned:boolean; bridgeOwned:boolean;
  macLearnedOnTunnel:boolean; handshakeAtMs:number;
};
export type LanActivationTarget=Omit<LanProofIdentity,"observedAtMs"> & {
  lanCidr:string; addressMode:"DHCP"|"Static";
  staticAddress:string|null; staticGateway:string|null;
  status:"Provisioning";
};
export type LanActivationResult={address:string;leaseExpiresAt:Date|null};
/**
 * Independent root-controlled observations: the node agent witnesses the
 * application netns and the enrolled Gate witnesses its own bridge/FDB and
 * authenticated WireGuard. Neither a tenant POST nor a desired-state record
 * can produce one of these proofs. Callers MUST additionally authenticate
 * the source channels and match the running Docker task + current revision.
 */
export function validateLanActivationProof(target:LanActivationTarget,
  node:NodeLanProof, gate:GateLanProof, now=Date.now()):LanActivationResult {
  if(target.status!=="Provisioning"||!Number.isSafeInteger(now)||now<0 ||
    ![target.attachmentId,target.tenantId,target.singleAppId,target.gateId].every(x=>identity.test(x))||
    !Number.isSafeInteger(target.configurationRevision)||target.configurationRevision<1||
    !mac.test(target.macAddress)||
    (parseInt(target.macAddress.slice(0,2),16)&3)!==2)
    throw new Error("Attachment has no valid activation identity");
  for(const proof of [node,gate]) {
    if(proof.attachmentId!==target.attachmentId||
      proof.tenantId!==target.tenantId||proof.singleAppId!==target.singleAppId||
      proof.gateId!==target.gateId||
      proof.configurationRevision!==target.configurationRevision||
      proof.macAddress.toLowerCase()!==target.macAddress.toLowerCase()||
      !Number.isSafeInteger(proof.observedAtMs)||
      proof.observedAtMs<now-proofAge||proof.observedAtMs>now+clockSkew)
      throw new Error("Stale, foreign or wrong-revision L2 observation");
  }
  if(node.source!=="node-agent"||gate.source!=="gate-agent"||
    !/^[0-9a-f]{64}$/i.test(node.taskContainerId)||
    !/^[a-z0-9]{12,64}$/.test(node.nodeTaskId)||
    !node.appLinkOwned||!node.appLinkUp||!node.overlayPeerMatched||
    !node.dockerDefaultPreserved||
    !gate.gatewayTunnelOwned||!gate.bridgeOwned||!gate.macLearnedOnTunnel||
    !Number.isSafeInteger(gate.handshakeAtMs)||
    gate.handshakeAtMs<=now-150_000||gate.handshakeAtMs>now+clockSkew)
    throw new Error("L2 dataplane or independent observer is not ready");
  const network=parseIpv4Cidr(target.lanCidr);
  if(!network||!containsIpv4(network,node.address)||
    parseIpv4Cidr(node.address+"/32")?.network===network.network||
    parseIpv4Cidr(node.address+"/32")?.network===network.broadcast||
    node.prefix!==network.prefix||node.mode!==target.addressMode)
    throw new Error("Node address is not a usable host in the granted LAN");
  const normalized=normalizeLanAddress({
    lanCidr:target.lanCidr,addressMode:target.addressMode,
    staticAddress:target.staticAddress,staticGateway:target.staticGateway,
  });
  if(normalized.addressMode==="Static") {
    if(node.address+"/"+node.prefix!==normalized.staticAddress ||
       node.staticGateway!==normalized.staticGateway||node.sourcePolicyVerified!==true||
       node.dhcpServer!==undefined||node.leaseExpiresAtMs!==undefined)
      throw new Error("Static address or source-specific gateway policy not proven");
    return {address:node.address,leaseExpiresAt:null};
  }
  const lease=node.leaseExpiresAtMs;
  if(typeof node.dhcpServer!=="string"||
     !parseIpv4Cidr(node.dhcpServer+"/32")||
     typeof lease!=="number"||!Number.isSafeInteger(lease)||
     lease<now+30_000||lease>now+90*24*3600*1000||
     node.staticGateway!==undefined||node.sourcePolicyVerified!==undefined)
    throw new Error("No fresh independently observed DHCP lease");
  return {address:node.address,leaseExpiresAt:new Date(lease)};
}
