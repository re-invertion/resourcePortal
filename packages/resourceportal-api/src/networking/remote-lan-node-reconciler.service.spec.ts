/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import { RemoteLanNodeReconcilerService } from "./remote-lan-node-reconciler.service";

const tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const gateId="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const appId="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const networkId="aaaaaaaa-bbbb-4ccc-8ddd-121212121212";
const attachmentId="aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const networkName="rp-network-"+networkId;
const networkTask="f43xw3tvy8t5t1p2v1nbu049a";
const networkDocker="8k3x2q1g8hwew7vrdnzldvqw4";
const row={
  id:attachmentId, tenantId, gateId, networkId, singleAppId:appId,
  macAddress:"02:aa:bb:cc:dd:ee", lanCidr:"192.168.50.0/24",
  createdAt:new Date(), status:"Provisioning",
  gate: {id:gateId,tenantId,status:"Ready",revokedAt:null,agentVersion:"gate-l2-v1",
    serverTunnelAddress:"100.96.1.1/30",clientTunnelAddress:"100.96.1.2/30"},
  network:{id:networkId,tenantId,status:"Ready",swarmNetworkName:networkName,
    overlayCidr:"10.200.42.0/24"},
  singleApp:{id:appId,pendingDeletion:false,desiredReplicas:1,appGroup:{tenantId}},
};
class Harness extends RemoteLanNodeReconcilerService {
  calls: string[][]=[];
  servicePresent=true;
  serviceError="No such service";
  policyEnv:string[]=[];
  capabilities:string[]=[];
  grantCapabilities=true;
  taskNetwork=networkDocker;
  currentTask=true;
  taskAttempts=0;
  taskReadyAfter=0;
  taskCopies=1;
  protected override async pauseForGatewayTaskChange(): Promise<void> { /* no CI delay */ }
  protected override docker(args: string[]): string {
    this.calls.push(args);
    const query=args.slice(0,2).join(" ");
    if (query==="network inspect") return this.taskNetwork;
    if (query==="service ps") {
      if (args.includes("--format")) return "Running 20 seconds ago";
      this.taskAttempts++;
      return Array.from({length:this.taskCopies}, (_,i)=>i===0 ? networkTask : "z".repeat(25)).join("\\n");
    }
    if (query==="inspect --type") return JSON.stringify({
      Status:{State:this.currentTask && this.taskAttempts>this.taskReadyAfter?"running":"failed"},
      NetworksAttachments:[{Network:{ID:networkDocker},Addresses:["10.200.42.20/24"]}],
    });
    if (query==="service inspect"){
      if(!this.servicePresent) throw new Error(this.serviceError);
      return JSON.stringify(args.at(-1)?.includes("CapabilityAdd") ?
        this.capabilities : this.policyEnv);
    }
    if (query==="service update") {
      if(this.grantCapabilities) {
        for(let i=0;i<args.length;i++) {
          if(args[i]==="--cap-add") this.capabilities.push("CAP_"+args[++i]);
        }
      }
      const existing = new Map(this.policyEnv.map(value=>[value.split("=")[0],value]));
      for(let i=0;i<args.length;i++) {
        if (args[i]==="--env-rm") existing.delete(args[++i]);
        if (args[i]==="--env-add") {
          const value=args[++i];
          existing.set(value.split("=")[0],value);
        }
      }
      this.policyEnv=[...existing.values()];
      return "updated";
    }
    throw new Error("Unexpected docker command: "+args.join(" "));
  }
}
function fixture(flag="true", rows: unknown[]=[row]){
  const prisma={remoteLanAttachment:{findMany:vi.fn().mockResolvedValue(rows)}};
  const config={get:vi.fn((key:string, fallback?:string)=>key==="REMOTE_LAN_L2_ENABLED"
    ? flag : fallback)};
  const service=new Harness(prisma as unknown as PrismaService,
    config as unknown as ConfigService);
  return {prisma,config,service};
}
describe("Remote LAN node policy rollout",()=>{
  it("binds policy to exactly one observed running Gateway task on the tenant overlay",async()=>{
    const {service,prisma}=fixture();
    const result=await service.reconcile();
    expect(result).toMatchObject({changed:true,attachments:1,disabled:false});
    expect(prisma.remoteLanAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:{status:{in:["Provisioning","Active"]}},
    }));
    const env=service.policyEnv[0];
    expect(env).toMatch(/^RESOURCEPORTAL_REMOTE_LAN_NODES_B64=/);
    const policy=JSON.parse(Buffer.from(env.split("=")[1],"base64").toString("utf8"));
    expect(policy).toEqual({version:1,attachments:[{
      attachmentId,tenantId,singleAppId:appId,gateId,networkName,
      overlayCidr:"10.200.42.0/24",lanCidr:"192.168.50.0/24",gatewayOverlayIp:"10.200.42.20",
      macAddress:"02:aa:bb:cc:dd:ee",
    }]});
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
    expect((await service.reconcile()).changed).toBe(false);
    expect(service.capabilities.sort()).toEqual(["CAP_NET_ADMIN","CAP_SYS_ADMIN","CAP_SYS_PTRACE"].sort());
    const updates=service.calls.filter(x=>x[0]==="service"&&x[1]==="update");
    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
    expect(updates[1]).toContain("--cap-add");
    expect(updates[2]).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
  });
  it("re-publishes authorized policy after capability repair revokes an existing grant",async()=>{
    const {service}=fixture();
    await service.reconcile();
    const original=service.policyEnv.find(x=>x.startsWith("RESOURCEPORTAL_REMOTE_LAN_NODES_B64="));
    expect(original).toBeDefined();
    service.capabilities=[];
    const before=service.calls.filter(x=>x[0]==="service"&&x[1]==="update").length;
    const result=await service.reconcile();
    expect(result).toMatchObject({changed:true,attachments:1,disabled:false});
    expect(service.policyEnv).toContain(original);
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
    const updates=service.calls.filter(x=>x[0]==="service"&&x[1]==="update").slice(before);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
    expect(updates[1]).toContain("--cap-add");
    expect(updates[2]).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
  });
  it("disabled rollout replaces prior policy with an empty fail-closed snapshot",async()=>{
    const {service,prisma}=fixture("false");
    service.policyEnv=["RESOURCEPORTAL_REMOTE_LAN_NODES_B64=stale"];
    expect(await service.reconcile()).toMatchObject({attachments:0,disabled:true,changed:true});
    expect(prisma.remoteLanAttachment.findMany).not.toHaveBeenCalled();
    const policy=JSON.parse(Buffer.from(service.policyEnv[0].split("=")[1],"base64").toString("utf8"));
    expect(policy).toEqual({version:1,attachments:[]});
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
  });
  it("disabled rollout tolerates an older stack that lacks the new agent",async()=>{
    const {service}=fixture("false");
    service.servicePresent=false;
    expect(await service.reconcile()).toMatchObject({attachments:0,disabled:true});
  });
  it("does not misreport a Docker outage as a harmless missing legacy service",async()=>{
    const {service}=fixture("false");
    service.servicePresent=false;
    service.serviceError="Connection to Docker daemon refused";
    await expect(service.reconcile()).rejects.toThrow(/revocation was not confirmed/);
  });
  it("fails closed for an un-certified Gate, cross-tenant network, or replicated app",async()=>{
    for(const patch of [
      {gate:{...row.gate,agentVersion:"gate-shell-v3"}},
      {network:{...row.network,tenantId:gateId}},
      {singleApp:{...row.singleApp,desiredReplicas:2}},
    ]){
      const {service}=fixture("true",[{...row,...patch}]);
      await expect(service.reconcile()).rejects.toThrow(/authorization/);
      expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
      expect(service.calls.filter(x=>x[0]==="service"&&x[1]==="update")).toHaveLength(1);
    }
  });
  it("revokes a previously distributed grant after tenant authorization fails",async()=>{
    const {service}=fixture();
    await service.reconcile();
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
    const failed=fixture("true",[{...row,network:{...row.network,tenantId:gateId}}]).service;
    failed.policyEnv=[...service.policyEnv];
    await expect(failed.reconcile()).rejects.toThrow(/authorization/);
    expect(failed.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
    const policy=JSON.parse(Buffer.from(failed.policyEnv.find(x=>
      x.startsWith("RESOURCEPORTAL_REMOTE_LAN_NODES_B64="))!.split("=")[1],"base64").toString("utf8"));
    expect(policy).toEqual({version:1,attachments:[]});
  });
  it("never activates L2 when Swarm refuses required Linux capabilities",async()=>{
    const {service}=fixture();
    service.grantCapabilities=false;
    await expect(service.reconcile()).rejects.toThrow(/capabilities were not applied/);
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
  });

  it("surfaces a rollback failure instead of claiming that dangerous grants were revoked",async()=>{
    const {service}=fixture("true",[{...row,gate:{...row.gate,agentVersion:"untrusted"}}]);
    service.servicePresent=false;
    await expect(service.reconcile()).rejects.toThrow(/revocation was not confirmed/);
  });
  it("recovers a Gate overlay task that becomes running during a bounded re-observation",async()=>{
    const {service}=fixture();
    service.taskReadyAfter=1;
    const result=await service.reconcile();
    expect(result).toMatchObject({attachments:1,disabled:false});
    expect(service.taskAttempts).toBe(2);
    expect(service.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=true");
  });
  it("does not publish a guessed Gateway IP when tasks stay absent or ambiguous",async()=>{
    const missing=fixture().service;
    missing.currentTask=false;
    await expect(missing.reconcile()).rejects.toThrow(/tasks=1,running=0,addresses=0/);
    expect(missing.taskAttempts).toBe(3);
    expect(missing.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
    const ambiguous=fixture().service;
    ambiguous.taskCopies=2;
    await expect(ambiguous.reconcile()).rejects.toThrow(/tasks=2,running=2,addresses=2/);
    expect(ambiguous.taskAttempts).toBe(3);
    expect(ambiguous.policyEnv).toContain("RP_REMOTE_LAN_NODE_ENABLED=false");
  });
  it("fails closed for missing, duplicate or foreign Gate task IP",async()=>{
    const {service}=fixture();
    service.currentTask=false;
    await expect(service.reconcile()).rejects.toThrow(/exactly one/);
    const next=fixture().service;
    next.taskNetwork="not-a-docker-id";
    await expect(next.reconcile()).rejects.toThrow(/Docker network/);
  });
});
