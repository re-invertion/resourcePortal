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
