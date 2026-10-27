import {REMOTE_LAN_PROOF_MAX_AGE_MS} from "./remote-lan-proof-age";
import type {NodeLanProof} from "./remote-lan-activation-proof";

const taskId=/^[a-z0-9]{12,64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxAge=REMOTE_LAN_PROOF_MAX_AGE_MS;
export type NodeLanSnapshot={taskId:string;observedAtMs:number;attachmentIds:string[];proofs:NodeLanProof[]};

/**
 * Docker service logs are authenticated by the manager's Docker API, not
 * supplied by tenants. Filter to the CURRENT running global agent task IDs,
 * and require one recent successful reconcile marker from EVERY task.
 * No marker means no authorization and no revocation acknowledgement.
 */
export function parseNodeLanServiceLogs(logs:string, expectedTasks:readonly string[],
  now=Date.now()):NodeLanSnapshot[] {
  if(!expectedTasks.length||expectedTasks.length>128||
    expectedTasks.some(id=>!taskId.test(id))||
    new Set(expectedTasks).size!==expectedTasks.length)
    throw new Error("No unambiguous running global node agents");
  if(logs.length>2_000_000)throw new Error("Oversized node proof log");
  const states=new Map<string,{observedAtMs:number;attachmentIds:string[];proofs:NodeLanProof[]}>();
  const pending=new Map<string,NodeLanProof[]>();
  const expected=new Set(expectedTasks);
  const shortIds=new Map<string,string|null>();
  for(const id of expectedTasks) {
    const short=id.slice(0,12);
    shortIds.set(short,shortIds.has(short)?null:id);
  }
  for(const raw of logs.split(/\r?\n/)) {
    // Nest's production logger can append ANSI reset codes after JSON.
    // Strip terminal coloring without removing Docker's task attribution.
    const line=raw.replace(new RegExp(String.fromCharCode(27)+"\\[[0-9;]*m","g"),"");
    if(!line.includes("RP_LAN_NODE_"))continue;
    // Default (non --raw) Docker Swarm log prefix binds to a task, not an
    // arbitrary application-supplied field inside a JSON log message.
    const prefix=line.match(/^(?:\d{4}-\d\d-\d\dT\S+\s+)?\S+\.\S+\.([a-z0-9]{12,64})@\S+\s+\|\s+(?:\d{4}-\d\d-\d\dT\S+\s+)?/);
    if(!prefix)continue;
    const displayed=prefix[1];
    const task=displayed.length===12?shortIds.get(displayed):
      expected.has(displayed)?displayed:undefined;
    if(!task)continue;
    const marker=line.match(/\bLOG\s+\[RemoteLanNode\]\s+RP_LAN_NODE_(PROOF|RECONCILE)_V1\s+(\{.*\})\s*$/);
    if(!marker)continue;
    let payload:unknown;
    try {payload=JSON.parse(marker[2]);} catch {continue;}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))continue;
    const obj=payload as Record<string,unknown>;
    if(obj.nodeTaskId!==task)continue;
    if(marker[1]==="RECONCILE") {
      if(!Number.isSafeInteger(obj.observedAtMs)||
        (obj.observedAtMs as number)<now-maxAge||
        (obj.observedAtMs as number)>now+5000||
        !Array.isArray(obj.attachmentIds)||obj.attachmentIds.length>512||
        !obj.attachmentIds.every(x=>typeof x==="string"&&uuid.test(x))||
        new Set(obj.attachmentIds).size!==obj.attachmentIds.length)continue;
      const existing=states.get(task);
      if(!existing||(obj.observedAtMs as number)>=existing.observedAtMs)
        states.set(task,{observedAtMs:obj.observedAtMs as number,
          attachmentIds:obj.attachmentIds as string[],proofs:(pending.get(task)??[])
            .filter(p=>Number.isSafeInteger(p.observedAtMs)&&
              p.observedAtMs>=(obj.observedAtMs as number)-10_000&&
              p.observedAtMs<=(obj.observedAtMs as number)+1000)});
      pending.set(task,[]);
    } else {
      // Proofs precede their cycle's successful reconcile marker. A later
      // marker replaces all prior observations for that task.
      if(!Number.isSafeInteger(obj.observedAtMs)||
        (obj.observedAtMs as number)<now-maxAge||
        (obj.observedAtMs as number)>now+5000)continue;
      const queued=pending.get(task)??[];
      if(queued.length<512)queued.push(obj as unknown as NodeLanProof);
      pending.set(task,queued);
    }
  }
  if(states.size!==expected.size)throw new Error("Missing fresh reconciliation from one or more Swarm nodes");
  return expectedTasks.map(id=>({taskId:id,...states.get(id)!}));
}
