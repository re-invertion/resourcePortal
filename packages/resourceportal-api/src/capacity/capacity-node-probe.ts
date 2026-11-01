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

type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;

async function readCgroupForPid(pid: number, readTextFile: ReadTextFile) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const membership = await readTextFile(
    HOST_PROC + "/" + pid + "/cgroup",
    "utf8",
  ).catch(() => null);
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
    readTextFile(root + "/memory.current", "utf8").catch(() => null),
    readTextFile(root + "/memory.peak", "utf8").catch(() => null),
    readTextFile(root + "/memory.events", "utf8").catch(() => null),
    readTextFile(root + "/memory.pressure", "utf8").catch(() => null),
  ]);
  if (
    currentRaw === null ||
    peakRaw === null ||
    eventsRaw === null ||
    pressureRaw === null
  ) {
    return null;
  }

  const currentValue = currentRaw.trim();
  const peakValue = peakRaw.trim();
  if (!/^\d+$/.test(currentValue) || !/^\d+$/.test(peakValue)) {
    return null;
  }
  const event = (name: string) => {
    const match = eventsRaw.match(
      new RegExp("(?:^|\\n)" + name + "\\s+(\\d+)"),
    );
    return match ? BigInt(match[1]) : null;
  };
  const oom = event("oom");
  const oomKill = event("oom_kill");
  if (oom === null || oomKill === null) return null;

  const current = BigInt(currentValue);
  const peakCandidate = BigInt(peakValue);
  const peak = peakCandidate > current ? peakCandidate : current;
  const pressure = parsePressure(pressureRaw);
  return {
    current,
    peak,
    oom: oom + oomKill,
    someAvg10: pressure.someAvg10,
    fullAvg10: pressure.fullAvg10,
  };
}

function parseContainerRows(raw: string):
  | { success: true; rows: Array<{ id: string; appId: string }> }
  | { success: false; reason: "ContainerInventoryTooLarge" | "ContainerInventoryMalformed" } {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 512) {
    return { success: false, reason: "ContainerInventoryTooLarge" };
  }

  const rows: Array<{ id: string; appId: string }> = [];
  const ids = new Set<string>();
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length !== 2) {
      return { success: false, reason: "ContainerInventoryMalformed" };
    }
    const [id = "", appId = ""] = parts;
    if (
      !CONTAINER_ID.test(id) ||
      !APP_ID.test(appId) ||
      ids.has(id)
    ) {
      return { success: false, reason: "ContainerInventoryMalformed" };
    }
    ids.add(id);
    rows.push({ id, appId });
  }
  return { success: true, rows };
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

export async function probeSwarmNodeCapacity(
  dependencies: {
    docker?: (args: string[], timeoutMs: number) => Promise<string | null>;
    readFile?: ReadTextFile;
  } = {},
): Promise<CapacityNodeProbeReport> {
  const runDocker = dependencies.docker ?? docker;
  const readTextFile: ReadTextFile =
    dependencies.readFile ??
    ((path, encoding) => readFile(path, encoding));

  const nodeId = await runDocker(
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
    readTextFile(HOST_PROC + "/meminfo", "utf8").catch(() => null),
    readTextFile(HOST_PROC + "/pressure/memory", "utf8").catch(() => ""),
    runDocker(
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

  const parsedContainerRows = parseContainerRows(containersRaw);
  if (!parsedContainerRows.success) {
    return {
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: parsedContainerRows.reason,
    };
  }
  const containerRows = parsedContainerRows.rows;
  let inspectRows = new Map<string, { pid: number; startedAt?: string }>();
  if (containerRows.length > 0) {
    const inspect = await runDocker(
      [
        "inspect",
        "--format",
        "{{.Id}}\t{{.State.Pid}}\t{{.State.StartedAt}}",
        ...containerRows.map((item) => item.id),
      ],
      8_000,
    );
    if (inspect === null) {
      return {
        status: "Unavailable",
        swarmNodeId: nodeId,
        reason: "ContainerInspectUnavailable",
      };
    }
    inspectRows = parseInspectRows(inspect);
    if (
      inspectRows.size !== containerRows.length ||
      containerRows.some((row) => !inspectRows.has(row.id))
    ) {
      return {
        status: "Unavailable",
        swarmNodeId: nodeId,
        reason: "ContainerInspectIncomplete",
      };
    }
  }

  const containers: CapacityNodeContainerProbe[] = [];
  for (const row of containerRows) {
    const state = inspectRows.get(row.id);
    if (!state) {
      return {
        status: "Unavailable",
        swarmNodeId: nodeId,
        reason: "ContainerInspectIncomplete",
      };
    }
    const cgroup = await readCgroupForPid(state.pid, readTextFile);
    if (!cgroup) {
      return {
        status: "Unavailable",
        swarmNodeId: nodeId,
        reason: "ContainerTelemetryUnavailable",
      };
    }
    containers.push({
      id: row.id,
      appId: row.appId,
      startedAt: state.startedAt,
      memoryCurrentBytes: cgroup.current.toString(),
      memoryPeakBytes: cgroup.peak.toString(),
      oomEvents: cgroup.oom.toString(),
      memoryPsiSomeAvg10: cgroup.someAvg10,
      memoryPsiFullAvg10: cgroup.fullAvg10,
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
