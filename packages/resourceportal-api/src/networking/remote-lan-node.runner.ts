import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { requireEffectiveCapabilities } from "./runtime-capabilities";
import {
  DHCP_PROOF_LOG_INTERVAL_MS,
  dhcpClientStopped,
  reconcileNodeLanDhcp,
} from "./remote-lan-dhcp-recovery";
import {inspectStaticRoutingClaim,parseStaticTableRead,type StaticRoutingClaim} from "./remote-lan-static-routing";
import type {NodeLanProof} from "./remote-lan-activation-proof";
import {
  assertCreatedNodeLanLink, assertOwnedNodeLanLink,
  nodeLanCommands, staticNodeLanCommands, selectNodeLanTargets,
  validateNodeLanSnapshot,
  type TenantContainer, type NodeLanTarget, type NodeLanLink,
} from "./remote-lan-node-policy";

const logger = new Logger("RemoteLanNode");
const SNAPSHOT = "RESOURCEPORTAL_REMOTE_LAN_NODES_B64";
const SCRIPT = "/usr/local/sbin/rp-remote-lan-dhcp.sh";
const HOST_PROC = "/host/proc";
type Address = { ifname?: string; addr_info?: Array<{ family?: string; local?: string; prefixlen?: number }> };
type Running = { target: NodeLanTarget; device: string; dhcp: ChildProcess | null; dockerDefault:string };
const managed = new Map<string, Running>();
const lastDhcpRestartAt = new Map<string, number>();
const lastMissingProofLogAt = new Map<string, number>();
let stopping = false;

function run(program: string, args: string[], allowFailure = false): string {
  const child = spawnSync(program, args, { encoding: "utf8", timeout: 12_000 });
  if ((child.status ?? 1) !== 0 && !allowFailure) {
    throw new Error(program + " failed: " + (child.stderr || child.error?.message || "exit " + child.status));
  }
  return (child.stdout ?? "").trim();
}
function namespacePath(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 2)
    throw new Error("Invalid tenant network namespace PID");
  return HOST_PROC + "/" + pid + "/ns/net";
}
function nsrun(pid: number, args: string[], allowFailure = false): string {
  return run("nsenter", ["--net=" + namespacePath(pid), "--", "ip", ...args], allowFailure);
}
function nsjson<T>(pid: number, args: string[]): T {
  return JSON.parse(nsrun(pid, args) || "[]") as T;
}
function snapshot() {
  // Image/stack upgrades never enable privileged attachment by accident.
  // Even a stale nonempty snapshot is inert until the worker rolls out the
  // new transport and explicitly enables the node agent.
  if (process.env.RP_REMOTE_LAN_NODE_ENABLED !== "true") return [];
  const encoded = process.env[SNAPSHOT];
  // Never create privileged links from an absent, damaged or legacy policy.
  if (!encoded || encoded.length > 300_000)
    throw new Error("Missing or oversized node LAN policy snapshot");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return validateNodeLanSnapshot(JSON.parse(decoded) as unknown);
}
function runningTenantContainers(): TenantContainer[] {
  const ids = run("docker", ["ps", "-q", "--no-trunc", "--filter",
    "label=resourceportal.workload=tenant"]).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const inspected = JSON.parse(run("docker", ["inspect", ...ids])) as unknown;
  if (!Array.isArray(inspected) || inspected.length !== ids.length)
    throw new Error("Docker inspect did not return all tenant workloads");
  return inspected as TenantContainer[];
}
function overlayInterface(target: NodeLanTarget): string {
  const addresses = nsjson<Address[]>(target.pid, ["-j", "-4", "addr", "show"]);
  const interfaces = addresses.filter(item => item.addr_info?.some(info =>
    info.family === "inet" && info.local === target.tunnel.appOverlayIp));
  if (interfaces.length !== 1 || !interfaces[0].ifname ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/.test(interfaces[0].ifname) ||
      /^rp-a-/.test(interfaces[0].ifname))
    throw new Error("Tenant overlay source interface is missing or ambiguous");
  return interfaces[0].ifname;
}
function links(pid: number): NodeLanLink[] {
  return nsjson<NodeLanLink[]>(pid, ["-d", "-j", "link", "show"]);
}
function staticClaim(target:NodeLanTarget,device:string):StaticRoutingClaim {
  const addr=target.attachment.staticAddress;
  const gateway=target.attachment.staticGateway;
  if(target.attachment.addressMode!=="Static"||!addr||!gateway)
    throw new Error("Static cleanup cannot infer trusted source/gateway");
  return {source:addr.split("/")[0],gateway,device};
}
/**
 * Linux FIB table 20015 does not exist until the first Static route is
 * inserted. Only this exact iproute2 ENOENT diagnostic means empty table.
 * Never hide EACCES, other netlink errors, or unexpected command output.
 */
function staticTableRoutes(pid:number): string {
  const result=spawnSync("nsenter", [
    "--net="+namespacePath(pid),"--","ip","-4","route","show","table","20015",
  ], {encoding:"utf8",timeout:12_000});
  if(result.error) throw new Error("Static LAN route inspection failed: "+result.error.message);
  return parseStaticTableRead(result.status, result.stdout??"", result.stderr??"");
}
function currentStaticClaim(pid:number,claim:StaticRoutingClaim) {
  const rules=nsrun(pid,["-4","rule","show"]);
  const routes=staticTableRoutes(pid);
  return inspectStaticRoutingClaim(claim,rules,routes);
}
function removeStaticClaim(pid:number,claim:StaticRoutingClaim) {
  for(const args of currentStaticClaim(pid,claim).cleanup)
    nsrun(pid,[...args]);
}
/**
 * A crashed agent has no in-memory map of its old app routing rules. The RP
 * GRETAP ifalias is an ownership anchor; before deleting an orphan endpoint,
 * remove ONLY its source-bound priority+route when both refer to that link.
 * Unknown tables or policy owners fail closed.
 */
function cleanupOrphanStaticPolicy(pid:number,device:string) {
  const rules=nsrun(pid,["-4","rule","show"]);
  const routes=staticTableRoutes(pid);
  const lines=rules.split(/\r?\n/).map(x=>x.trim());
  const pref=lines.filter(line=>/^18015:/.test(line));
  if(!pref.length && !routes.trim()) return;
  if(pref.length>1) throw new Error("Ambiguous orphan RP LAN routing priority");
  const rule=pref[0]?.match(/^18015:\s+from ((?:\d{1,3}\.){3}\d{1,3})(?:\/32)? lookup 20015(?:\s|$)/);
  if(pref.length && !rule) throw new Error("Unowned orphan static source rule");
  const route=routes.trim().match(/^default via ((?:\d{1,3}\.){3}\d{1,3}) dev (rp-a-[0-9a-f]{8})(?:\s|$)/);
  if(routes.trim() && (!route || route[2]!==device))
    throw new Error("Orphan static table belongs to a different device");
  const ips=nsjson<Address[]>(pid,["-j","-4","addr","show","dev",device])
    .flatMap(x=>x.addr_info??[]).filter(x=>x.family==="inet").map(x=>x.local);
  if(rule && !ips.includes(rule[1]))
    throw new Error("Orphan static source was not assigned to RP-owned endpoint");
  if(!rule && ips.length!==1)
    throw new Error("Cannot establish orphan static route source identity");
  const claim={device,source:rule?.[1]??ips[0]??"",
    gateway:route?.[1]??"0.0.0.1"};
  for(const command of inspectStaticRoutingClaim(claim,rules,routes).cleanup)
    nsrun(pid,[...command]);
}
function attach(target: NodeLanTarget): Running {
  const dockerDefault = nsrun(target.pid,["-4","route","show","default"]);
  if (dockerDefault.split(/\r?\n/).filter(Boolean).length!==1 ||
      /\bdev rp-a-[0-9a-f]{8}\b/.test(dockerDefault))
    throw new Error("Docker default route is missing, ambiguous or points into RP LAN");
  const interfaceName = overlayInterface(target);
  const commands = nodeLanCommands(target, interfaceName);
  const device = commands[0][1][2];
  const before = links(target.pid).find(link => link.ifname === device);
  if (before) {
    assertOwnedNodeLanLink(before, device, target.attachment.attachmentId);
  } else {
    let created = false;
    try {
      for (const [, args] of commands) {
        nsrun(target.pid, [...args]);
        if (!created) {
          created = true;
          nsrun(target.pid, ["link", "set", "dev", device, "alias",
            "rp-lan:" + target.attachment.attachmentId]);
        }
      }
    } catch (error) {
      // Never delete a pre-existing link when "ip link add" failed, nor
      // a newly created link that was subsequently moved to another bridge.
      if (created) {
        try {
          const partial = links(target.pid).find(link => link.ifname === device);
          if (partial) {
            assertCreatedNodeLanLink(partial, device, target.attachment.attachmentId);
            nsrun(target.pid, ["link", "delete", device]);
          }
        } catch (cleanupError) {
          logger.error("Partial LAN tunnel cleanup blocked: " + String(cleanupError));
        }
      }
      throw error;
    }
  }
  if(target.attachment.addressMode==="Static") {
    // Exact desired owner may be adopted across an agent restart; never
    // override a foreign policy or reuse a stale route with wrong gateway.
    const claim=staticClaim(target,device);
    const current=currentStaticClaim(target.pid,claim);
    const ips=nsjson<Address[]>(target.pid,["-j","-4","addr","show","dev",device]);
    const configured=ips.some(x=>x.addr_info?.some(a=>
      a.family==="inet" && a.local===claim.source));
    if(current.fullyConfigured && configured) return {target,device,dhcp:null,dockerDefault};
    removeStaticClaim(target.pid,claim);
    const oldDefault=nsrun(target.pid,["-4","route","show","default"]);
    try {
      // Linux ARP duplicate detection from the new L2 endpoint before IP
      // assignment. A missing BusyBox feature is an explicit failure.
      const ip=target.attachment.staticAddress!.split("/")[0];
      run("nsenter",["--net="+namespacePath(target.pid),"--","/bin/busybox",
        "arping","-D","-f","-c","3","-w","5","-I",device,ip]);
      for(const args of staticNodeLanCommands(target,device))
        nsrun(target.pid,[...args]);
      if(nsrun(target.pid,["-4","route","show","default"])!==oldDefault)
        throw new Error("Static LAN must preserve the tenant Docker default route");
    } catch(error) {
      removeStaticClaim(target.pid,claim);
      throw error;
    }
    return {target,device,dhcp:null,dockerDefault};
  }
  const dhcp = spawn("nsenter", [
    "--net=" + namespacePath(target.pid), "--", "/bin/busybox", "udhcpc",
    // Keep retrying if the L2 tunnel or customer DHCP server comes online
    // after the application. -n made the client exit after the initial
    // attempts; a still-managed tunnel would then never acquire a lease.
    "-f", "-i", device, "-s", SCRIPT,
  ], { stdio: "ignore",
    // The DHCP hook must never accept an address outside the tenant-approved LAN.
    env: { ...process.env, RP_REMOTE_LAN_CIDR: target.attachment.lanCidr,
      RP_LAN_DHCP_PROOF_FILE: "/run/resourceportal-remote-lan/" + device },
  });
  dhcp.on("error", err => logger.error("DHCP client failed: " + err.message));
  return { target, device, dhcp, dockerDefault };
}
function observeNodeProof(entry:Running):NodeLanProof {
  const {target,device}=entry;
  const link=links(target.pid).find(x=>x.ifname===device);
  if(!link)throw new Error("Node L2 tunnel disappeared");
  assertOwnedNodeLanLink(link,device,target.attachment.attachmentId);
  if(link.address?.toLowerCase() !==
     target.attachment.macAddress.toLowerCase())
    throw new Error("RP-owned node tunnel MAC differs from granted application");
  const addresses=nsjson<Array<{ifname?:string;addr_info?:Array<{
    family?:string;local?:string;prefixlen?:number}>}>>(
    target.pid,["-j","-4","addr","show","dev",device])
    .flatMap(x=>x.addr_info??[]).filter(x=>x.family==="inet");
  if(addresses.length!==1||!addresses[0].local||
      !Number.isInteger(addresses[0].prefixlen))
    throw new Error("Node L2 address not uniquely configured");
  const targetMode=target.attachment.addressMode??"DHCP";
  const result:NodeLanProof={
    source:"node-agent",
    attachmentId:target.attachment.attachmentId,
    tenantId:target.attachment.tenantId,
    singleAppId:target.attachment.singleAppId,
    gateId:target.attachment.gateId,
    configurationRevision:target.attachment.configurationRevision??1,
    macAddress:target.attachment.macAddress,
    observedAtMs:Date.now(),
    taskContainerId:target.id,
    nodeTaskId:process.env.RESOURCEPORTAL_LAN_NODE_TASK_ID??"",
    mode:targetMode,
    address:addresses[0].local,prefix:addresses[0].prefixlen!,
    appLinkOwned:true,appLinkUp:link.flags?.includes("UP")===true,
    overlayPeerMatched:link.linkinfo?.info_data?.local===target.tunnel.appOverlayIp&&
      link.linkinfo?.info_data?.remote===target.tunnel.gatewayOverlayIp,
    dockerDefaultPreserved:nsrun(target.pid,["-4","route","show","default"])===entry.dockerDefault,
  };
  if(targetMode==="Static") {
    const claim=staticClaim(target,device);
    const routing=currentStaticClaim(target.pid,claim);
    result.sourcePolicyVerified=routing.fullyConfigured;
    result.staticGateway=claim.gateway;
  } else {
    // A failed spawn can return ChildProcess with pid=undefined before the
    // asynchronous error event. Never accept an old DHCP ACK from such a
    // process as active lease evidence.
    if (dhcpClientStopped(entry.dhcp))
      throw new Error("DHCP process not alive");
    // Only the authenticated node agent's DHCP hook can write this path.
    const lease=readFileSync("/run/resourceportal-remote-lan/"+device,"utf8")
      .trim().split(/\r?\n/);
    if(lease.length!==5 || lease[0]!==result.address ||
        Number(lease[1])!==result.prefix ||
        !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lease[2]))
      throw new Error("DHCP ACK proof disagrees with netns address");
    const seconds=Number(lease[3]),issued=Number(lease[4]);
    if(!Number.isSafeInteger(seconds)||seconds<60||seconds>7776000||
      !Number.isSafeInteger(issued)||issued*1000>Date.now()+5000)
      throw new Error("DHCP lease metadata missing or malformed");
    result.dhcpServer=lease[2];
    result.leaseExpiresAtMs=(issued+seconds)*1000;
  }
  return result;
}

function detach(entry: Running) {
  entry.dhcp?.kill("SIGTERM");
  if(entry.dhcp) {
    try { unlinkSync("/run/resourceportal-remote-lan/"+entry.device); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  }
  const { target, device } = entry;
  let present: NodeLanLink | undefined;
  try {
    present = links(target.pid).find(link => link.ifname === device);
  } catch {
    // The container exited; its Linux network namespace was removed.
    return;
  }
  if (!present) return;
  assertOwnedNodeLanLink(present, device, target.attachment.attachmentId);
  if(target.attachment.addressMode==="Static")
    removeStaticClaim(target.pid,staticClaim(target,device));
  nsrun(target.pid, ["link", "delete", device]);
}
function reconcile() {
  const containers = runningTenantContainers();
  let targets: NodeLanTarget[] = [];
  let denied: unknown = null;
  try {
    // Invalid or absent policy means ZERO grants, not "keep last working".
    targets = selectNodeLanTargets(snapshot(), containers);
  } catch (error) {
    denied = error;
  }
  const desired = new Map(targets.map(target =>
    [target.id + ":" + target.attachment.attachmentId, target]));
  // Revoke stale managed and orphan links independently before granting
  // replacements. Any bridged/foreign refusal blocks new grants but cannot
  // prevent revocation of unrelated stale endpoints in other namespaces.
  const pids: number[] = [];
  for (const container of containers) {
    if (!container.State?.Running || !container.State.Pid ||
        !Number.isSafeInteger(container.State.Pid)) continue;
    pids.push(container.State.Pid);
  }
  for (const [key] of lastDhcpRestartAt) {
    if (!desired.has(key)) lastDhcpRestartAt.delete(key);
  }
  for (const [key] of lastMissingProofLogAt) {
    if (!desired.has(key)) lastMissingProofLogAt.delete(key);
  }
  reconcileNodeLanDhcp(managed, desired, pids, detach, links, (pid, ifname) => {
    cleanupOrphanStaticPolicy(pid, ifname);
    nsrun(pid, ["link", "delete", ifname]);
  }, attach, lastDhcpRestartAt, Date.now(), attachmentId => {
    logger.warn("Stopped LAN DHCP client for attachment " + attachmentId +
      "; reattachment delayed to prevent restart loops");
  });
  if (denied) throw denied instanceof Error ? denied : new Error("Invalid node LAN policy");
  // Docker Swarm service logs come from a privileged, RP-owned node agent,
  // never from tenant container stdout. Worker independently binds the
  // resulting proof to running task identity, Gate and current revision.
  for(const [key, entry] of managed){
    try {
      logger.log("RP_LAN_NODE_PROOF_V1 "+JSON.stringify(observeNodeProof(entry)));
      lastMissingProofLogAt.delete(key);
    } catch (error) {
      // Retain the fail-closed proof requirement, but report WHY it is
      // missing. Previously this error was silently discarded and the UI
      // stayed Provisioning indefinitely without actionable diagnostics.
      const now = Date.now();
      if (now - (lastMissingProofLogAt.get(key) ?? 0) >= DHCP_PROOF_LOG_INTERVAL_MS) {
        logger.warn("LAN evidence pending for attachment " +
          entry.target.attachment.attachmentId + ": " +
          (error instanceof Error ? error.message : "unavailable"));
        lastMissingProofLogAt.set(key, now);
      }
    }
  }
  logger.log("RP_LAN_NODE_RECONCILE_V1 "+JSON.stringify({
    observedAtMs:Date.now(),
    nodeTaskId:process.env.RESOURCEPORTAL_LAN_NODE_TASK_ID??"",
    attachmentIds:[...managed.values()].map(x=>x.target.attachment.attachmentId).sort(),
  }));
  return managed.size;
}
async function main() {
  const enabled = process.env.RP_REMOTE_LAN_NODE_ENABLED === "true";
  // This service is deployed inert before L2 certification. Swarm may not
  // grant requested capabilities until the post-deploy capability reconcile;
  // do not restart-loop an inert service in that intermediate state.
  if (enabled) {
    requireEffectiveCapabilities("Remote LAN node agent", ["NET_ADMIN", "SYS_ADMIN", "SYS_PTRACE"]);
  }
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      if (!enabled) {
        await new Promise(resolve => setTimeout(resolve, 5_000));
        continue;
      }
      try {
        logger.log("Node LAN attachments=" + reconcile());
      } catch (err) {
        logger.error("LAN reconciliation blocked: " + String(err));
      }
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  } finally {
    for (const [key, entry] of managed) {
      try { detach(entry); } catch (err) { logger.error("LAN revoke failed: " + String(err)); }
      managed.delete(key);
    }
  }
}
void main().catch(error => { logger.error(String(error)); process.exitCode = 1; });
