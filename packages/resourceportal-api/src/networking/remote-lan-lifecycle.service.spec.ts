import { describe,expect,it,vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import { RemoteLanLifecycleService } from "./remote-lan-lifecycle.service";

const tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const appId="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const gateId="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const networkId="aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc";
const row={
  id:"aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd",
  tenantId, networkId, singleAppId:appId,
  lanCidr:"192.168.60.0/24", status:"Pending",
  gate:{id:gateId,tenantId,status:"Ready",agentVersion:"gate-l2-v1",
    lanCidrs:["192.168.60.0/24"], revokedAt:null,
    serverTunnelAddress:"100.96.0.1/30",clientTunnelAddress:"100.96.0.2/30"},
  network:{tenantId,status:"Ready",id:networkId},
  singleApp:{id:appId,pendingDeletion:false,desiredReplicas:1,
    appGroup:{tenantId},networkAttachments:[{networkId}]},
};
function fixture(flag="true", rows:unknown[]=[row]){
  const prisma={remoteLanAttachment:{
    findMany:vi.fn().mockResolvedValue(rows),
    updateMany:vi.fn().mockResolvedValue({count:1}),
  }};
  const config={get:vi.fn((key:string)=>key==="REMOTE_LAN_L2_ENABLED"?flag:undefined)};
  return {prisma,service:new RemoteLanLifecycleService(
    prisma as unknown as PrismaService,config as unknown as ConfigService)};
}
describe("Remote LAN Pending -> Provisioning handoff",()=>{
  it("starts a certified, tenant-scoped, single-replica L2 attachment but not Active",async()=>{
    const {prisma,service}=fixture();
    expect(await service.reconcile()).toEqual({provisioned:1,waiting:0,disabled:false});
    expect(prisma.remoteLanAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:{status:"Pending"},
    }));
    expect(prisma.remoteLanAttachment.updateMany).toHaveBeenCalledWith({
      where:{id:row.id,tenantId,status:"Pending"},
      data:{status:"Provisioning",lastError:null,dhcpAddress:null,leaseExpiresAt:null},
    });
  });
  it("permits dedicated unnumbered handoffs that advertise no host-side LAN route",async()=>{
    const {prisma,service}=fixture("true",[{...row,gate:{...row.gate,lanCidrs:[]}}]);
    expect(await service.reconcile()).toMatchObject({provisioned:1,waiting:0});
    expect(prisma.remoteLanAttachment.updateMany).toHaveBeenCalledOnce();
  });
  it("does not start L2 when feature is not globally enabled",async()=>{
    const {prisma,service}=fixture("false");
    expect(await service.reconcile()).toEqual({provisioned:0,waiting:0,disabled:true});
    expect(prisma.remoteLanAttachment.findMany).not.toHaveBeenCalled();
  });
  it("waits without touching data for untrusted Gate, foreign tenant, or detached workload",async()=>{
    for(const patch of [
      {gate:{...row.gate,agentVersion:"gate-shell-v3"}},
      {gate:{...row.gate,revokedAt:new Date()}},
      {gate:{...row.gate,serverTunnelAddress:null}},
      {network:{...row.network,tenantId:gateId}},
      {singleApp:{...row.singleApp,desiredReplicas:2}},
      {singleApp:{...row.singleApp,networkAttachments:[]}},
      {singleApp:{...row.singleApp,appGroup:{tenantId:gateId}}},
    ]){
      const {prisma,service}=fixture("true",[{...row,...patch}]);
      expect(await service.reconcile()).toEqual({provisioned:0,waiting:1,disabled:false});
      expect(prisma.remoteLanAttachment.updateMany).not.toHaveBeenCalled();
    }
  });
  it("does not count a concurrent revoked/changed attachment as provisioned",async()=>{
    const {prisma,service}=fixture();
    prisma.remoteLanAttachment.updateMany.mockResolvedValue({count:0});
    expect(await service.reconcile()).toEqual({provisioned:0,waiting:0,disabled:false});
  });
  it("does not touch Revoking or Active: cleanup and lease proof are separate gates",async()=>{
    const {prisma,service}=fixture("true",[]);
    await service.reconcile();
    expect(prisma.remoteLanAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:{status:"Pending"},
    }));
    expect(prisma.remoteLanAttachment.updateMany).not.toHaveBeenCalled();
  });
});

const proofTask="a".repeat(25);
const containerId="c".repeat(64);
function proofLog(task:string,kind:string,payload:unknown){
  return `2026-10-27T00:34:40.639315543Z resourceportal-control-plane_remote-lan-node.0.${task.slice(0,12)}@seprd1    | [Nest] 1 - LOG [RemoteLanNode] RP_LAN_NODE_${kind}_V1 ${JSON.stringify({nodeTaskId:task,...(payload as object)})}`;
}
describe("production LAN activation and revocation ingestion",()=>{
  const nodeProof=(now:number)=>({
    source:"node-agent",attachmentId:row.id,tenantId,singleAppId:appId,
    gateId,configurationRevision:1,macAddress:"02:11:22:33:44:55",
    observedAtMs:now-2000,taskContainerId:containerId,mode:"DHCP",
    address:"192.168.60.20",prefix:24,appLinkOwned:true,appLinkUp:true,
    overlayPeerMatched:true,dockerDefaultPreserved:true,
    dhcpServer:"192.168.60.1",leaseExpiresAtMs:now+3600000,
  });
  const gateProof=(now:number)=>({
    source:"gate-agent",attachmentId:row.id,tenantId,singleAppId:appId,
    gateId,configurationRevision:1,macAddress:"02:11:22:33:44:55",
    observedAtMs:now-2000,gatewayTunnelOwned:true,bridgeOwned:true,
    macLearnedOnTunnel:true,handshakeAtMs:now-5000,
  });
  function make(now:number,status="Provisioning",nodePresent=true){
    const n=nodeProof(now);
    const g=gateProof(now);
    const data={
      ...row,gateId,status,updatedAt:new Date(now-15_000),macAddress:n.macAddress,
      addressMode:"DHCP",staticAddress:null,staticGateway:null,
      configurationRevision:1,
      network:{...row.network,status:"Ready"},
      singleApp:{...row.singleApp,appGroup:{tenantId},
        networkAttachments:[{networkId}]},
      gate:{...row.gate,agentVersion:"gate-l2-v2",status:"Ready",
        observedL2:status==="Revoking"?[]:[g],
        observedL2At:new Date(now-1000),
        observedL2AppliedAt:new Date(now-3000)},
    };
    const lines=[
      ...(nodePresent?[proofLog(proofTask,"PROOF",n)]:[]),
      proofLog(proofTask,"RECONCILE",{
        observedAtMs:now-1000,
        attachmentIds:nodePresent?[row.id]:[],
      }),
    ].join("\n");
    const {prisma,service}=fixture("true",[data]);
    const docker=vi.spyOn(service as unknown as {docker:(args:string[])=>string},"docker");
    docker.mockImplementation(args=>args[1]==="ps"?
      proofTask+" Running 3 seconds ago":lines);
    return {prisma,service};
  }
  it("promotes Provisioning to Active only with both authenticated proofs",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now);
    expect(await service.reconcileActivation()).toMatchObject({activated:1,revoked:0});
    const write=prisma.remoteLanAttachment.updateMany.mock.calls[0]?.[0] as unknown;
    expect(write).toMatchObject({
      where:{status:{in:["Provisioning","Active"]},configurationRevision:1},
      data:{status:"Active",dhcpAddress:"192.168.60.20"},
    });
    expect((write as {data:{leaseExpiresAt:unknown}}).data.leaseExpiresAt)
      .toBeInstanceOf(Date);
  });
  it("keeps Revoking until Gate applied a newer policy and every node has detached",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now,"Revoking",false);
    expect(await service.reconcileActivation()).toMatchObject({revoked:1});
    const write=prisma.remoteLanAttachment.updateMany.mock.calls[0]?.[0] as unknown;
    expect(write).toMatchObject({data:{status:"Revoked"}});
  });
  it("never acknowledges revocation while node still reports a grant",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now,"Revoking",true);
    expect(await service.reconcileActivation()).toMatchObject({revoked:0});
    expect(prisma.remoteLanAttachment.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed on Docker log outage or failed node policy reconciliation",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now,"Active",true);
    expect(await service.reconcileActivation(false)).toMatchObject({degraded:1,activated:0});
    const write=prisma.remoteLanAttachment.updateMany.mock.calls[0]?.[0] as unknown;
    expect(write).toMatchObject({data:{status:"Provisioning"}});
    const {prisma:second,service:broken}=make(now,"Active",true);
    vi.spyOn(broken as unknown as {docker:(args:string[])=>string},"docker")
      .mockImplementation(()=>{throw new Error("Docker daemon unavailable");});
    expect(await broken.reconcileActivation()).toMatchObject({degraded:1,activated:0});
    expect(second.remoteLanAttachment.updateMany).toHaveBeenCalled();
  });
  it("keeps Provisioning fail-closed and exposes a fixed missing Gate proof category",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now);
    const rows=await prisma.remoteLanAttachment.findMany() as unknown as
      Array<{gate:Record<string,unknown>;lastError:string|null}>;
    prisma.remoteLanAttachment.findMany.mockResolvedValueOnce([{...rows[0],
      gate:{...rows[0].gate,observedL2:[]},lastError:null}]);
    expect(await service.reconcileActivation()).toMatchObject({activated:0});
    expect(prisma.remoteLanAttachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({data:{lastError:"Gate L2 proof missing or ambiguous"}}));
    expect(prisma.remoteLanAttachment.updateMany.mock.calls.some(call =>
      (call[0] as {data:{status?:string}}).data.status==="Active")).toBe(false);
  });
  it("demotes Active on missing app proof instead of retaining stale lease",async()=>{
    const now=Date.now();
    const {prisma,service}=make(now,"Active",false);
    expect(await service.reconcileActivation()).toMatchObject({degraded:1});
    const write=prisma.remoteLanAttachment.updateMany.mock.calls[0]?.[0] as unknown;
    expect(write).toMatchObject({data:{
      status:"Provisioning",dhcpAddress:null,leaseExpiresAt:null,
    }});
  });
});
