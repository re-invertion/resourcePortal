import {describe,it,expect} from "vitest";
import {parseNodeLanServiceLogs} from "./remote-lan-proof-logs";
const now=1_800_000_000_000;
const task1="a".repeat(25),task2="b".repeat(25);
const attachmentId="aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd";
const log=(task:string,marker:string,data:unknown)=>
  `resourceportal-control-plane_remote-lan-node.0.${task}@node1 | 2026-10-25T09:00:00Z [Nest] LOG [RemoteLanNode] RP_LAN_NODE_${marker}_V1 ${JSON.stringify({nodeTaskId:task,...(data as object)})}`;
const cycle=(task:string,attachments:string[],proofs:unknown[]=[])=>[
  ...proofs.map(p=>log(task,"PROOF",p)),
  log(task,"RECONCILE",{observedAtMs:now-1000,attachmentIds:attachments})
].join("\n");
describe("Docker Swarm authenticated global node observations",()=>{
  it("accepts fresh markers from every current agent and pairs proof to its cycle",()=>{
    const proof={source:"node-agent",attachmentId,nodeTaskId:task1,observedAtMs:now-1100};
    const data=cycle(task1,[attachmentId],[proof])+"\n"+cycle(task2,[]);
    const nodes=parseNodeLanServiceLogs(data,[task1,task2],now);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].proofs).toEqual([proof]);
    expect(nodes[1].attachmentIds).toEqual([]);
  });

  it("accepts actual timestamp-leading Docker logs with shortened task prefix and full payload principal",()=>{
    const full="pxu0nrwqj8qr8gniyslgbkna5";
    const line=(kind:string,payload:object)=>
      "2026-10-27T00:34:40.639315543Z resourceportal-control-plane_remote-lan-node.0."+
      full.slice(0,12)+"@seprd1    | [Nest] 1 - 10/27/2026, 12:34:40 AM "+
      "LOG [RemoteLanNode] RP_LAN_NODE_"+kind+"_V1 "+
      JSON.stringify({nodeTaskId:full,...payload});
    const proof={attachmentId,observedAtMs:now-1100,source:"node-agent"};
    const logs=line("PROOF",proof)+"\n"+
      line("RECONCILE",{observedAtMs:now-1000,attachmentIds:[attachmentId]});
    const parsed=parseNodeLanServiceLogs(logs,[full],now);
    expect(parsed[0].taskId).toBe(full);
    expect(parsed[0].proofs).toEqual([{nodeTaskId:full,...proof}]);
    expect(parsed[0].attachmentIds).toEqual([attachmentId]);
  });
  it("rejects ambiguous abbreviated task identities and forged full payload principal",()=>{
    const full="pxu0nrwqj8qr8gniyslgbkna5";
    const rival=full.slice(0,12)+"anotheruniqueid";
    const line=(payloadId:string)=>"2026-10-27T00:34:40.639315543Z "+
      "resourceportal-control-plane_remote-lan-node.0."+full.slice(0,12)+"@seprd1 | "+
      "[Nest] LOG [RemoteLanNode] RP_LAN_NODE_RECONCILE_V1 "+
      JSON.stringify({nodeTaskId:payloadId,observedAtMs:now-1000,attachmentIds:[]});
    expect(()=>parseNodeLanServiceLogs(line(full),[full,rival],now)).toThrow(
      /Missing fresh reconciliation/);
    expect(()=>parseNodeLanServiceLogs(line(rival),[full],now)).toThrow(
      /Missing fresh reconciliation/);
    expect(parseNodeLanServiceLogs(line(full),[full],now)).toHaveLength(1);
  });
  it("rejects absent node marker, stale cycle and empty agent set",()=>{
    expect(()=>parseNodeLanServiceLogs(cycle(task1,[]),[task1,task2],now)).toThrow();
    expect(()=>parseNodeLanServiceLogs("",[],now)).toThrow();
    expect(()=>parseNodeLanServiceLogs(cycle(task1,[]).replace(String(now-1000),String(now-45000)),[task1],now)).toThrow();
  });
  it("ignores stale prior task, tenant-injected text and a proof after last marker",()=>{
    const stale=log("c".repeat(25),"RECONCILE",{observedAtMs:now-1000,attachmentIds:[]});
    const after=log(task1,"PROOF",{attachmentId,observedAtMs:now});
    const data=stale+"\n"+cycle(task1,[])+"\n"+after;
    expect(parseNodeLanServiceLogs(data,[task1],now)[0].proofs).toEqual([]);
  });
  it("accepts ANSI-coded Nest logs but rejects false node principal",()=>{
    const body=cycle(task1,[],[{attachmentId,observedAtMs:now-1200}]);
    const colored=body.replaceAll("\n","\u001b[39m\n")+"\u001b[39m";
    expect(parseNodeLanServiceLogs(colored,[task1],now)).toHaveLength(1);
    const forged=log(task1,"RECONCILE",{nodeTaskId:task2,observedAtMs:now-1000,attachmentIds:[]});
    expect(()=>parseNodeLanServiceLogs(forged,[task1],now)).toThrow();
  });
  it("latest successful reconcile supersedes earlier attached state",()=>{
    const data=cycle(task1,[attachmentId])+"\n"+
      log(task1,"RECONCILE",{observedAtMs:now,attachmentIds:[]});
    expect(parseNodeLanServiceLogs(data,[task1],now)[0].attachmentIds).toEqual([]);
  });
});
