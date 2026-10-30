import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CapacityNodeContainerProbe = {
  id: string;
  appId: string;
  startedAt?: string;
  memoryCurrentBytes: string;
  memoryPeakBytes: string;
  oomEvents: string;
  memoryPsiSomeAvg10?: number;
  memoryPsiFullAvg10?: number;
};

export type CapacityNodeProbeReport =
  | {
      status: "Observed";
      swarmNodeId: string;
      memoryTotalBytes: string;
      memoryAvailableBytes: string;
      memoryPsiSomeAvg10: number;
      memoryPsiFullAvg10: number;
      containers: CapacityNodeContainerProbe[];
    }
  | {
      status: "Unavailable";
      swarmNodeId: string | null;
      reason: string;
    };

const NODE_ID = /^[a-z0-9]{20,64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const APP_ID = /^[a-zA-Z0-9._:-]{1,160}$/;
const HOST_PROC = process.env.RESOURCEPORTAL_HOST_PROC_ROOT || "/host/proc";
const HOST_CGROUP =
  process.env.RESOURCEPORTAL_HOST_CGROUP_ROOT || "/host/sys/fs/cgroup";

async function docker(
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolveResult) => {
    let output = "";
    let done = false;
    const child = spawn("docker", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LC_ALL: "C",
      },
    });
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (part: Buffer) => {
      if (output.length + part.length > 512_000) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      output += part.toString("utf8");
    });
    child.stderr.on("data", () => {
      // Read-only probe. Error details are intentionally not exposed.
    });
    child.on("error", () => finish(null));
    child.on("close", (exitCode) =>
      finish(exitCode === 0 ? output.trim() : null),
    );
  });
}

export function parseMeminfo(raw: string) {
  const values = new Map<string, bigint>();
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1], BigInt(match[2]) * 1024n);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable") ?? values.get("MemFree");
  if (!totalBytes || availableBytes === undefined || availableBytes > totalBytes) {
    return null;
  }
  return { totalBytes, availableBytes };
}

export function parsePressure(raw: string) {
  const read = (kind: "some" | "full") => {
    const line = raw
      .split("\n")
      .find((item) => item.trim().startsWith(kind + " "));
    const match = line?.match(/\bavg10=([0-9.]+)/);
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return { someAvg10: read("some"), fullAvg10: read("full") };
}

function safeCgroupRoot(relative: string) {
  if (!relative.startsWith("/") || relative.includes("..")) return null;
  const root = resolve(HOST_CGROUP);
  const target = resolve(root, "." + relative);
  if (target !== root && !target.startsWith(root + "/")) return null;
  return target;
}

async function readCgroupForPid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const membership = await readFile(HOST_PROC + "/" + pid + "/cgroup", "utf8").catch(
    () => null,
  );
  if (!membership) return null;
  const unified = membership
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^0::\//.test(line));
  if (!unified) return null;
  const relative = unified.slice(3);
  const root = safeCgroupRoot(relative);
  if (!root) return null;

  const [currentRaw, peakRaw, eventsRaw, pressureRaw] = await Promise.all([
    readFile(root + "/memory.current", "utf8").catch(() => "0"),
    readFile(root + "/memory.peak", "utf8").catch(() => "0"),
    readFile(root + "/memory.events", "utf8").catch(() => ""),
    readFile(root + "/memory.pressure", "utf8").catch(() => ""),
  ]);
  const current = /^\d+$/.test(currentRaw.trim())
    ? BigInt(currentRaw.trim())
    : 0n;
  const peakCandidate = /^\d+$/.test(peakRaw.trim())
    ? BigInt(peakRaw.trim())
    : current;
  const peak = peakCandidate > current ? peakCandidate : current;
  const event = (name: string) =>
    BigInt(eventsRaw.match(new RegExp("(?:^|\\n)" + name + "\\s+(\\d+)"))?.[1] ?? "0");
  const pressure = parsePressure(pressureRaw);
  return {
    current,
    peak,
    oom: event("oom") + event("oom_kill"),
    someAvg10: pressure.someAvg10,
    fullAvg10: pressure.fullAvg10,
  };
}

function parseContainerRows(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", appId = ""] = line.split("\t");
      return { id, appId };
    })
    .filter(
      (item) => CONTAINER_ID.test(item.id) && APP_ID.test(item.appId),
    )
    .slice(0, 512);
}

function parseInspectRows(raw: string) {
  const rows = new Map<string, { pid: number; startedAt?: string }>();
  for (const line of raw.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const [id = "", pidRaw = "", startedAt = ""] = line.split("\t");
    if (!CONTAINER_ID.test(id)) continue;
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.set(id, {
      pid,
      startedAt:
        startedAt && Number.isFinite(Date.parse(startedAt))
          ? startedAt
          : undefined,
    });
  }
  return rows;
}

export async function probeSwarmNodeCapacity(): Promise<CapacityNodeProbeReport> {
  const nodeId = await docker(
    ["info", "--format", "{{.Swarm.NodeID}}"],
    4_000,
  );
  if (!nodeId || !NODE_ID.test(nodeId)) {
    return {
      status: "Unavailable",
      swarmNodeId: null,
      reason: "SwarmNodeIdentityUnavailable",
    };
  }

  const [meminfoRaw, pressureRaw, containersRaw] = await Promise.all([
    readFile(HOST_PROC + "/meminfo", "utf8").catch(() => null),
    readFile(HOST_PROC + "/pressure/memory", "utf8").catch(() => ""),
    docker(
      [
        "ps",
        "--no-trunc",
        "--filter",
        "label=resourceportal.single-app-id",
        "--format",
        '{{.ID}}\t{{.Label "resourceportal.single-app-id"}}',
      ],
      5_000,
    ),
  ]);
  const memory = meminfoRaw ? parseMeminfo(meminfoRaw) : null;
  if (!memory) {
    return {
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "HostMemAvailableUnavailable",
    };
  }
  if (containersRaw === null) {
    return {
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "ContainerInventoryUnavailable",
    };
  }

  const containerRows = parseContainerRows(containersRaw);
  let inspectRows = new Map<string, { pid: number; startedAt?: string }>();
  if (containerRows.length > 0) {
    const inspect = await docker(
      [
        "inspect",
        "--format",
        "{{.Id}}\t{{.State.Pid}}\t{{.State.StartedAt}}",
        ...containerRows.map((item) => item.id),
      ],
      8_000,
    );
    if (inspect !== null) inspectRows = parseInspectRows(inspect);
  }

  const containers: CapacityNodeContainerProbe[] = [];
  for (const row of containerRows) {
    const state = inspectRows.get(row.id);
    const cgroup = state ? await readCgroupForPid(state.pid) : null;
    containers.push({
      id: row.id,
      appId: row.appId,
      startedAt: state?.startedAt,
      memoryCurrentBytes: (cgroup?.current ?? 0n).toString(),
      memoryPeakBytes: (cgroup?.peak ?? cgroup?.current ?? 0n).toString(),
      oomEvents: (cgroup?.oom ?? 0n).toString(),
      memoryPsiSomeAvg10: cgroup?.someAvg10,
      memoryPsiFullAvg10: cgroup?.fullAvg10,
    });
  }

  const pressure = parsePressure(pressureRaw);
  return {
    status: "Observed",
    swarmNodeId: nodeId,
    memoryTotalBytes: memory.totalBytes.toString(),
    memoryAvailableBytes: memory.availableBytes.toString(),
    memoryPsiSomeAvg10: pressure.someAvg10,
    memoryPsiFullAvg10: pressure.fullAvg10,
    containers,
  };
}
