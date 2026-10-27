import {REMOTE_LAN_PROOF_MAX_AGE_MS} from "./remote-lan-proof-age";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {spawnSync} from "node:child_process";
import {parseNodeLanServiceLogs,type NodeLanSnapshot} from "./remote-lan-proof-logs";
import {validateLanActivationProof,type GateLanProof} from "./remote-lan-activation-proof";
import { PrismaService } from "../prisma/prisma.service";
import {verifiedManagedLan} from "./remote-lan-addressing";

/**
 * Desired-state handoff, not DHCP proof. A Pending attachment can only enter
 * Provisioning after an explicitly certified L2 Gate is ready. DHCP lease
 * evidence from both authenticated peers is required separately for Active.
 *
 * Revoking can be acknowledged only after a newer Gate applied-state
 * checkpoint AND a successful fresh empty reconcile from every Swarm node.
 */
@Injectable()
export class RemoteLanLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async reconcile() {
    if (this.config.get<string>("REMOTE_LAN_L2_ENABLED") !== "true")
      return { provisioned: 0, waiting: 0, disabled: true };

    const pending = await this.prisma.remoteLanAttachment.findMany({
      where: { status: "Pending" },
      include: {
        gate: true,
        network: true,
        singleApp: {
          include: { appGroup: true,
            networkAttachments: true },
        },
      },
    });
    let provisioned = 0;
    let waiting = 0;
    for (const row of pending) {
      let managedReady=true;
      if(row.uplinkMode==="ManagedSharedUplink") {
        try {
          const observed=verifiedManagedLan(row.gateId,row.lanInterface,
            row.gate.observedLan,row.gate.observedLanAt);
          managedReady=observed.networkCidr===row.lanCidr;
        } catch { managedReady=false; }
      }
      const ready = managedReady &&
        row.gate.tenantId === row.tenantId &&
        row.network.tenantId === row.tenantId &&
        row.singleApp.appGroup.tenantId === row.tenantId &&
        row.gate.revokedAt === null &&
        row.gate.status === "Ready" &&
        ["gate-l2-v1","gate-l2-v2"].includes(row.gate.agentVersion ?? "") &&
        row.network.status === "Ready" &&
        row.singleApp.pendingDeletion === false &&
        row.singleApp.desiredReplicas === 1 &&
        row.singleApp.networkAttachments.some(link => link.networkId === row.networkId) &&
        // Dedicated unnumbered LAN handoffs have NO routable Gate-side
        // prefix to report. The Gate enforces the physical link boundary.
        !!row.gate.serverTunnelAddress && !!row.gate.clientTunnelAddress;
      if (!ready) {
        waiting += 1;
        continue;
      }
      const claimed = await this.prisma.remoteLanAttachment.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: "Pending" },
        data: {
          status: "Provisioning",
          lastError: null,
          dhcpAddress: null,
          leaseExpiresAt: null,
        },
      });
      if (claimed.count === 1) provisioned += 1;
    }
    return { provisioned, waiting, disabled: false };
  }

  private docker(args:string[]):string {
    const context=this.config.get<string>("DOCKER_CONTEXT");
    const result=spawnSync("docker",context?["--context",context,...args]:args,{
      encoding:"utf8",timeout:15_000,maxBuffer:2_000_000,
    });
    if(result.status!==0)throw new Error("Remote LAN observation Docker read failed: "+
      (result.stderr||result.error?.message||result.status));
    return (result.stdout??"").trim();
  }

  /**
   * Only the privileged Swarm global node agent may emit these Docker
   * service logs; only the enrolled Gate bearer may populate observedL2.
   * Both must match current DB revision and the current successful task
   * cycle before any attachment becomes Active.
   */
  async reconcileActivation(nodePolicyHealthy=true){
    if(this.config.get<string>("REMOTE_LAN_L2_ENABLED")!=="true")
      return {activated:0,revoked:0,degraded:0,disabled:true};
    const rows=await this.prisma.remoteLanAttachment.findMany({
      where:{status:{in:["Provisioning","Active","Revoking"]}},
      include:{gate:true,network:true,
        singleApp:{include:{appGroup:true,networkAttachments:true}}},
    });
    if(!rows.length)return {activated:0,revoked:0,degraded:0,disabled:false};
    const stack=this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME",
      "resourceportal-control-plane");
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(stack))
      throw new Error("Invalid node agent Swarm service identity");
    const service=stack+"_remote-lan-node";
    const now=Date.now();
    let nodes:NodeLanSnapshot[]=[];
    let nodeProofsReady=false;
    if(nodePolicyHealthy){
      try{
        const taskLines=this.docker(["service","ps","--no-trunc",
          "--filter","desired-state=running","--format",
          "{{.ID}} {{.CurrentState}}",service]).split(/\r?\n/).filter(Boolean);
        const taskIds=taskLines.map(line=>{
          const match=line.match(/^([a-z0-9]{12,64})\s+Running(?:\s|$)/);
          if(!match)throw new Error("Node agent Swarm rollout is not converged");
          return match[1];
        });
        const logs=this.docker(["service","logs","--timestamps","--since","45s",
          "--tail","5000",service]);
        nodes=parseNodeLanServiceLogs(logs,taskIds,now);
        nodeProofsReady=true;
      }catch{/* A missing node or Docker outage must demote Active, not keep stale evidence. */}
    }
    let activated=0,revoked=0,degraded=0;
    for(const row of rows) {
      const gate=row.gate;
      const gateFresh=gate.tenantId===row.tenantId&&
        gate.agentVersion==="gate-l2-v2"&&gate.status==="Ready"&&
        !gate.revokedAt&&gate.observedL2At!==null&&
        now-gate.observedL2At.getTime()<=REMOTE_LAN_PROOF_MAX_AGE_MS&&
        gate.observedL2At.getTime()<=now+5000&&
        Array.isArray(gate.observedL2);
      const gateProofs=gateFresh ? gate.observedL2 as unknown as GateLanProof[] : [];
      if(row.status==="Revoking"){
        // The Gate attests that it applied a policy AFTER the revocation,
        // and all current node agents attest to an empty kernel grant.
        // Missing node, stale heartbeat or stale Gate apply ACK keeps the
        // durable Revoking record; never infer cleanup from desired state.
        const cutoff=row.updatedAt.getTime();
        const gateRemoved=gateFresh&&gate.observedL2AppliedAt!==null&&
          gate.observedL2AppliedAt.getTime()>=cutoff&&
          gate.observedL2At!.getTime()>=gate.observedL2AppliedAt.getTime()&&
          !gateProofs.some(p=>p.attachmentId===row.id);
        const nodesRemoved=nodeProofsReady&&nodes.every(n=>n.observedAtMs>=cutoff&&
          !n.attachmentIds.includes(row.id));
        if(gateRemoved&&nodesRemoved){
          const claimed=await this.prisma.remoteLanAttachment.updateMany({
            where:{id:row.id,tenantId:row.tenantId,status:"Revoking",
              configurationRevision:row.configurationRevision},
            data:{status:"Revoked",dhcpAddress:null,leaseExpiresAt:null,
              lastVerifiedAt:new Date(now),lastError:null},
          });
          revoked+=claimed.count;
        }
        continue;
      }
      let result:ReturnType<typeof validateLanActivationProof>|null=null;
      let reason="Authenticated LAN evidence not verified";
      try {
        if(!nodeProofsReady||!gateFresh||row.network.status!=="Ready"||
          row.network.tenantId!==row.tenantId||
          row.singleApp.appGroup.tenantId!==row.tenantId||
          row.singleApp.pendingDeletion||row.singleApp.desiredReplicas!==1||
          !row.singleApp.networkAttachments.some(n=>n.networkId===row.networkId))
          throw new Error("Gate, tenant app or network authorization is not ready");
        const matchingGate=gateProofs.filter(p=>p.attachmentId===row.id);
        const matchingNode=nodes.flatMap(n=>n.proofs)
          .filter(p=>p.attachmentId===row.id);
        if(matchingGate.length!==1||matchingNode.length!==1)
          throw new Error(matchingGate.length!==1
            ? "Gate L2 proof missing or ambiguous"
            : "Node L2 proof missing or ambiguous");
        const proof=matchingNode[0];
        // The node's own successful reconciliation must include the
        // attachment. A stale proof from an earlier cycle is not enough.
        if(!nodes.some(n=>n.attachmentIds.includes(row.id)&&
          n.proofs.includes(proof)))
          throw new Error("Node attachment proof is not in the current cycle");
        result=validateLanActivationProof({
          attachmentId:row.id,tenantId:row.tenantId,
          singleAppId:row.singleAppId,gateId:row.gateId,
          configurationRevision:row.configurationRevision,
          macAddress:row.macAddress,lanCidr:row.lanCidr,
          addressMode:row.addressMode as "DHCP"|"Static",
          staticAddress:row.staticAddress,staticGateway:row.staticGateway,
          status:"Provisioning",
        },proof,matchingGate[0],now);
      }catch(error){
        // Only closed-set categories are persisted: never expose untrusted
        // Docker output, tenant identifiers, host paths, tokens or policy JSON.
        if(error instanceof Error && [
          "Gate L2 proof missing or ambiguous", "Node L2 proof missing or ambiguous",
          "Node attachment proof is not in the current cycle",
        ].includes(error.message)) reason=error.message;
        else if(!nodeProofsReady)reason="Node reconciliation evidence unavailable";
        else if(!gateFresh)reason="Gate L2 observation missing or stale";
      }
      if(result){
        const claimed=await this.prisma.remoteLanAttachment.updateMany({
          where:{id:row.id,tenantId:row.tenantId,
            status:{in:["Provisioning","Active"]},
            configurationRevision:row.configurationRevision},
          data:{status:"Active",dhcpAddress:result.address,
            leaseExpiresAt:result.leaseExpiresAt,
            lastVerifiedAt:new Date(now),lastError:null},
        });
        if(row.status!=="Active")activated+=claimed.count;
      }else if(row.status==="Provisioning"){
        if(row.lastError!==reason)
          await this.prisma.remoteLanAttachment.updateMany({
            where:{id:row.id,tenantId:row.tenantId,status:"Provisioning",
              configurationRevision:row.configurationRevision},
            data:{lastError:reason},
          });
      }else if(row.status==="Active"){
        const claimed=await this.prisma.remoteLanAttachment.updateMany({
          where:{id:row.id,tenantId:row.tenantId,status:"Active",
            configurationRevision:row.configurationRevision},
          data:{status:"Provisioning",dhcpAddress:null,
            leaseExpiresAt:null,lastVerifiedAt:null,
            lastError:"Authenticated LAN dataplane evidence expired"},
        });
        degraded+=claimed.count;
      }
    }
    return {activated,revoked,degraded,disabled:false};
  }
}
