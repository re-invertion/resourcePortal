import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Logger } from "@nestjs/common";
import { requireEffectiveCapabilities } from "./runtime-capabilities";
import {
  assertCreatedNodeLanLink, assertOwnedNodeLanLink,
  nodeLanCommands, revokeNodeLanEntries, selectNodeLanTargets, sweepNodeLanOrphans,
  validateNodeLanSnapshot,
  type TenantContainer, type NodeLanTarget, type NodeLanLink,
} from "./remote-lan-node-policy";

const logger = new Logger("RemoteLanNode");
const SNAPSHOT = "RESOURCEPORTAL_REMOTE_LAN_NODES_B64";
const SCRIPT = "/usr/local/sbin/rp-remote-lan-dhcp.sh";
const HOST_PROC = "/host/proc";
type Address = { ifname?: string; addr_info?: Array<{ family?: string; local?: string }> };
type Running = { target: NodeLanTarget; device: string; dhcp: ChildProcess };
const managed = new Map<string, Running>();
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
function attach(target: NodeLanTarget): Running {
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
  const dhcp = spawn("nsenter", [
    "--net=" + namespacePath(target.pid), "--", "/bin/busybox", "udhcpc",
    "-f", "-n", "-i", device, "-s", SCRIPT,
  ], { stdio: "ignore",
    // The DHCP hook must never accept an address outside the tenant-approved LAN.
    env: { ...process.env, RP_REMOTE_LAN_CIDR: target.attachment.lanCidr },
  });
  dhcp.on("error", err => logger.error("DHCP client failed: " + err.message));
  return { target, device, dhcp };
}
function detach(entry: Running) {
  entry.dhcp.kill("SIGTERM");
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
  // Attempt every stale revocation, even if another link is foreign/bridged.
  // A failed revocation remains tracked and blocks all replacement grants.
  revokeNodeLanEntries(managed, desired, detach);
  for (const [key, target] of desired) {
    if (managed.has(key)) continue;
    managed.set(key, attach(target));
  }
  // Sweep all namespaces, even when a foreign bridge or an inaccessible
  // namespace blocks one orphan. No such link is ever deleted.
  const namespaces: Array<{ pid: number; active: Set<string> }> = [];
  for (const container of containers) {
    if (!container.State?.Running || !container.State.Pid ||
        !Number.isSafeInteger(container.State.Pid)) continue;
    const pid = container.State.Pid;
    namespaces.push({ pid, active: new Set([...managed.values()].filter(item =>
      item.target.pid === pid).map(item => item.device)) });
  }
  sweepNodeLanOrphans(namespaces, links, (pid, ifname) =>
    { nsrun(pid, ["link", "delete", ifname]); });
  if (denied) throw denied instanceof Error ? denied : new Error("Invalid node LAN policy");
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
