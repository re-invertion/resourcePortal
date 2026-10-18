import { spawnSync } from "node:child_process";
import { Logger } from "@nestjs/common";
import { managedRouteFlushArgs, managedTenantRoutePids } from "./app-lan-route-shutdown";
import {
  APP_LAN_ROUTE_PROTOCOL, desiredRoutesForContainer,
  validateLanRoutePolicy, type ApplicationLanRoute,
} from "./app-lan-routes";

const logger = new Logger("ApplicationLanRouteAgent");
let stopping = false;
let cleanupStarted = false;

function run(program: string, args: string[], allowFailure = false) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(program + " failed: " + (result.stderr || result.stdout || result.error?.message));
  }
  return { status: result.status, stdout: result.stdout?.trim() ?? "" };
}
function jsonRun(program: string, args: string[]): unknown {
  const output = run(program, args).stdout;
  return JSON.parse(output || "[]") as unknown;
}
function nsenter(pid: number, args: string[], allowFailure = false) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid PID");
  return run("nsenter", ["--net=/host/proc/" + pid + "/ns/net", "--", "ip", ...args], allowFailure);
}
function networkInterface(pid: number, source: string) {
  const value = JSON.parse(nsenter(pid, ["-j", "-4", "addr", "show"]).stdout || "[]") as Array<{
    ifname?: string; addr_info?: Array<{ local?: string }>;
  }>;
  const item = value.find(entry => entry.addr_info?.some(info => info.local === source));
  if (!item?.ifname || !/^[a-zA-Z0-9_.-]{1,15}$/.test(item.ifname)) {
    throw new Error("Overlay interface not found for application");
  }
  return item.ifname;
}
type DockerWorkloadInspect = {
  Id?: string;
  State?: { Pid?: number; Running?: boolean };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
};

function reconcileContainer(container: DockerWorkloadInspect, policies: ApplicationLanRoute[]) {
  const id = container.Id;
  const pid = container.State?.Pid;
  const labels = container.Config?.Labels ?? {};
  const networks = container.NetworkSettings?.Networks ?? {};
  if (typeof id !== "string" || container.State?.Running !== true || typeof pid !== "number" ||
    !Number.isSafeInteger(pid)) return;
  const desired = desiredRoutesForContainer(policies, labels, networks);
  const existing = JSON.parse(nsenter(pid, ["-j", "-4", "route", "show", "proto", APP_LAN_ROUTE_PROTOCOL]).stdout || "[]") as Array<{
    dst?: string; gateway?: string; dev?: string;
  }>;
  const desiredMap = new Map<string, { via: string; dev: string }>();
  for (const route of desired) {
    const source = networks[route.networkName]?.IPAddress;
    if (!source) throw new Error("Missing attached overlay IP");
    const dev = networkInterface(pid, source);
    const prior = desiredMap.get(route.destinationCidr);
    if (prior && (prior.via !== route.gatewayAddress || prior.dev !== dev)) {
      throw new Error("Conflicting application routes");
    }
    desiredMap.set(route.destinationCidr, { via: route.gatewayAddress, dev });
  }
  // Remove RP-owned routes that are no longer authorized, also after agent restart.
  for (const old of existing) {
    if (!old.dst || !old.gateway || !old.dev) continue;
    const next = desiredMap.get(old.dst);
    if (!next || next.via !== old.gateway || next.dev !== old.dev) {
      nsenter(pid, ["-4", "route", "del", old.dst, "proto", APP_LAN_ROUTE_PROTOCOL], true);
    }
  }
  for (const [destination, target] of desiredMap) {
    const current = existing.find(old => old.dst === destination &&
      old.gateway === target.via && old.dev === target.dev);
    if (!current) {
      nsenter(pid, [
        "-4", "route", "replace", destination, "via", target.via,
        "dev", target.dev, "proto", APP_LAN_ROUTE_PROTOCOL,
      ]);
    }
  }
}

function currentPolicy(): ApplicationLanRoute[] {
  const encoded = process.env.RESOURCEPORTAL_APP_LAN_ROUTES_B64;
  if (!encoded) return []; // No permissions: remove any previously managed routes.
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    return validateLanRoutePolicy(decoded);
  } catch (error) {
    logger.error("Invalid desired-state snapshot, revoking managed routes: " + String(error));
    return [];
  }
}
// Gracefully revoke routes from still-running SingleApp network namespaces
// before the node-local agent disappears during platform image rollback.
function shutdownAndRevokeRoutes() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  stopping = true;
  let failures = 0;
  try {
    const ids = run("docker", ["ps", "-q", "--filter", "label=resourceportal.workload=tenant"])
      .stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      const containers = jsonRun("docker", ["inspect", ...ids]);
      const pids = managedTenantRoutePids(containers);
      for (const pid of pids) {
        try {
          nsenter(pid, managedRouteFlushArgs());
        } catch (error) {
          failures++;
          logger.error("Unable to revoke RP-owned routes in namespace " + pid + ": " + String(error));
        }
      }
      logger.log("Shutdown revoked RP-owned routes in " + (pids.length - failures) +
        "/" + pids.length + " active tenant namespaces");
    }
  } catch (error) {
    failures++;
    logger.error("Site VPN route cleanup failed: " + String(error));
  }
  if (failures) process.exitCode = 1;
}

process.once("SIGTERM", shutdownAndRevokeRoutes);
process.once("SIGINT", shutdownAndRevokeRoutes);

async function main() {
  try {
    while (!stopping) {
      try {
        const ids = run("docker", [
        "ps", "-q", "--filter", "label=resourceportal.workload=tenant",
      ]).stdout.split(/\s+/).filter(Boolean);
      const containers = ids.length ? jsonRun("docker", ["inspect", ...ids]) : [];
      if (!Array.isArray(containers)) throw new Error("Unexpected Docker inspect result");
      const policy = currentPolicy();
      for (const container of containers) {
        if (!container || typeof container !== "object" || Array.isArray(container)) continue;
        reconcileContainer(container as DockerWorkloadInspect, policy);
      }
      } catch (error) {
        logger.error("Route reconciliation failed: " + String(error));
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } finally {
    shutdownAndRevokeRoutes();
  }
}
void main().catch(error => { logger.error(String(error)); process.exitCode = 1; });
