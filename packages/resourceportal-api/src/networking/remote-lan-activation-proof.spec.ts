import {describe,it,expect} from "vitest";
import {validateLanActivationProof,type GateLanProof,type LanActivationTarget,type NodeLanProof} from "./remote-lan-activation-proof";
const now=1_800_000_000_000;
const tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const singleAppId="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const gateId="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const attachmentId="aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd";
const macAddress="02:11:22:33:44:55";
const basis={attachmentId,tenantId,singleAppId,gateId,macAddress,configurationRevision:4};
const target=():LanActivationTarget=>({...basis,lanCidr:"192.168.60.0/24",
  addressMode:"DHCP",staticAddress:null,staticGateway:null,status:"Provisioning"});
const node=():NodeLanProof=>({...basis,observedAtMs:now-5000,source:"node-agent",
  taskContainerId:"a".repeat(64),nodeTaskId:"b".repeat(25),mode:"DHCP",address:"192.168.60.20",
  prefix:24,appLinkOwned:true,appLinkUp:true,overlayPeerMatched:true,
  dockerDefaultPreserved:true,dhcpServer:"192.168.60.1",
  leaseExpiresAtMs:now+3_600_000});
const gate=():GateLanProof=>({...basis,observedAtMs:now-5000,
  source:"gate-agent",gatewayTunnelOwned:true,bridgeOwned:true,
  macLearnedOnTunnel:true,handshakeAtMs:now-10000});
describe("independent Gate and application LAN activation proof",()=>{
  it("accepts paired, recent authenticated DHCP observations",()=>{
    expect(validateLanActivationProof(target(),node(),gate(),now)).toEqual({
      address:"192.168.60.20",leaseExpiresAt:new Date(now+3_600_000)});
  });
  it("requires fresh Gate MAC learned on authorized bridge and encrypted peer",()=>{
    for(const patch of [{macLearnedOnTunnel:false},{bridgeOwned:false},
      {gatewayTunnelOwned:false},{handshakeAtMs:now-100_000}]){
      expect(()=>validateLanActivationProof(target(),node(),{...gate(),...patch},now)).toThrow();
    }
  });
  it("rejects wrong tenant/app/gate/revision, stale observations and false container identity",()=>{
    for(const patch of [{tenantId:gateId},{singleAppId:tenantId},
      {configurationRevision:3},{observedAtMs:now-45_000},{taskContainerId:"bad"}])
      expect(()=>validateLanActivationProof(target(),{...node(),...patch},gate(),now)).toThrow();
  });
  it("rejects mismatched DHCP subnet, expired lease, damaged Docker route",()=>{
    for(const patch of [{address:"192.168.61.15"},{prefix:16},
      {leaseExpiresAtMs:now+2000},{dockerDefaultPreserved:false}])
      expect(()=>validateLanActivationProof(target(),{...node(),...patch},gate(),now)).toThrow();
  });
  it("accepts source-scoped Static only with exact route and address",()=>{
    const t={...target(),addressMode:"Static" as const,
      staticAddress:"192.168.60.44/24",staticGateway:"192.168.60.1"};
    const n={...node(),mode:"Static" as const,address:"192.168.60.44",
      staticGateway:"192.168.60.1",sourcePolicyVerified:true,
      dhcpServer:undefined,leaseExpiresAtMs:undefined};
    expect(validateLanActivationProof(t,n,gate(),now)).toEqual({
      address:"192.168.60.44",leaseExpiresAt:null});
    for(const patch of [{sourcePolicyVerified:false},{staticGateway:"192.168.60.2"},
      {address:"192.168.60.45"},{dhcpServer:"192.168.60.1"}])
      expect(()=>validateLanActivationProof(t,{...n,...patch},gate(),now)).toThrow();
  });
  it("never promotes Pending/Revoking or forged source types",()=>{
    for(const status of ["Pending","Revoking","Active"])
      expect(()=>validateLanActivationProof({...target(),status:status as "Provisioning"},node(),gate(),now)).toThrow();
    expect(()=>validateLanActivationProof(target(),{...node(),source:"gate-agent" as "node-agent"},gate(),now)).toThrow();
  });
});