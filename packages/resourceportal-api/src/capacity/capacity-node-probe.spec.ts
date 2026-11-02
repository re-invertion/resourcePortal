import { describe, expect, it } from "vitest";
import {
  parseMeminfo,
  parsePressure,
  probeSwarmNodeCapacity,
} from "./capacity-node-probe";

describe("capacity node probe parsers", () => {
  it("uses Linux MemAvailable instead of treating configured memory as live usage", () => {
    expect(
      parseMeminfo([
        "MemTotal:       65837248 kB",
        "MemFree:        1024000 kB",
        "MemAvailable:  47185920 kB",
      ].join("\n")),
    ).toEqual({
      totalBytes: 65837248n * 1024n,
      availableBytes: 47185920n * 1024n,
    });
  });

  it("rejects impossible host memory reports", () => {
    expect(
      parseMeminfo([
        "MemTotal: 1024 kB",
        "MemAvailable: 2048 kB",
      ].join("\n")),
    ).toBeNull();
  });

  it("parses bounded memory PSI avg10 pressure", () => {
    expect(
      parsePressure([
        "some avg10=12.50 avg60=5.00 avg300=1.00 total=10",
        "full avg10=1.25 avg60=0.50 avg300=0.10 total=2",
      ].join("\n")),
    ).toEqual({ someAvg10: 12.5, fullAvg10: 1.25 });
  });
});

const nodeId = "ku2gbq2sm1b2khra543dtyxfg";
const containerA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const containerB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const appId = "11111111-2222-3333-4444-555555555555";
const hostMeminfo = [
  "MemTotal:       65837248 kB",
  "MemFree:        1024000 kB",
  "MemAvailable:  47185920 kB",
].join("\n");
const pressure = [
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
  "full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
].join("\n");
const events = [
  "low 0",
  "high 0",
  "max 0",
  "oom 0",
  "oom_kill 0",
  "oom_group_kill 0",
].join("\n");

function baseReadFile(path: string): Promise<string> {
  if (path.endsWith("/meminfo")) return Promise.resolve(hostMeminfo);
  if (path.endsWith("/pressure/memory")) return Promise.resolve(pressure);
  if (path.endsWith("/123/cgroup")) return Promise.resolve("0::/docker/a\n");
  if (path.endsWith("/456/cgroup")) return Promise.resolve("0::/docker/b\n");
  if (path.endsWith("/memory.current")) return Promise.resolve("1073741824\n");
  if (path.endsWith("/memory.peak")) return Promise.resolve("1342177280\n");
  if (path.endsWith("/memory.events")) return Promise.resolve(events);
  if (path.endsWith("/memory.pressure")) return Promise.resolve(pressure);
  return Promise.reject(new Error("unexpected path: " + path));
}

describe("capacity node probe completeness", () => {
  it("returns unavailable when inspect omits one running replica", async () => {
    const docker = (args: string[]): Promise<string | null> => {
      if (args[0] === "info") return Promise.resolve(nodeId);
      if (args[0] === "ps") {
        return Promise.resolve(
          [
            containerA + "\t" + appId,
            containerB + "\t" + appId,
          ].join("\n"),
        );
      }
      if (args[0] === "inspect") {
        return Promise.resolve(
          containerA + "\t123\t2026-10-30T10:00:00.000Z",
        );
      }
      return Promise.resolve(null);
    };

    await expect(
      probeSwarmNodeCapacity({ docker, readFile: baseReadFile }),
    ).resolves.toEqual({
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "ContainerInspectIncomplete",
    });
  });

  it("returns unavailable when memory.current cannot be read for one replica", async () => {
    const docker = (args: string[]): Promise<string | null> => {
      if (args[0] === "info") return Promise.resolve(nodeId);
      if (args[0] === "ps") {
        return Promise.resolve(
          [
            containerA + "\t" + appId,
            containerB + "\t" + appId,
          ].join("\n"),
        );
      }
      if (args[0] === "inspect") {
        return Promise.resolve(
          [
            containerA + "\t123\t2026-10-30T10:00:00.000Z",
            containerB + "\t456\t2026-10-30T10:00:00.000Z",
          ].join("\n"),
        );
      }
      return Promise.resolve(null);
    };
    const readFile = (path: string): Promise<string> => {
      if (
        path.endsWith("/docker/b/memory.current")
      ) {
        return Promise.reject(new Error("unreadable memory.current"));
      }
      return baseReadFile(path);
    };

    await expect(
      probeSwarmNodeCapacity({ docker, readFile }),
    ).resolves.toEqual({
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "ContainerTelemetryUnavailable",
    });
  });
});

describe("capacity node probe inventory bounds", () => {
  it("returns unavailable instead of truncating more than 512 running RP containers", async () => {
    const inventory = Array.from({ length: 513 }, (_, index) => {
      const id = (index + 1).toString(16).padStart(64, "0");
      return id + "\t" + appId;
    }).join("\n");
    const docker = (args: string[]): Promise<string | null> => {
      if (args[0] === "info") return Promise.resolve(nodeId);
      if (args[0] === "ps") return Promise.resolve(inventory);
      return Promise.resolve(null);
    };

    await expect(
      probeSwarmNodeCapacity({ docker, readFile: baseReadFile }),
    ).resolves.toEqual({
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "ContainerInventoryTooLarge",
    });
  });

  it("returns unavailable instead of dropping malformed running-container rows", async () => {
    const docker = (args: string[]): Promise<string | null> => {
      if (args[0] === "info") return Promise.resolve(nodeId);
      if (args[0] === "ps") {
        return Promise.resolve(
          [
            containerA + "\t" + appId,
            "not-a-container-id\t" + appId,
          ].join("\n"),
        );
      }
      return Promise.resolve(null);
    };

    await expect(
      probeSwarmNodeCapacity({ docker, readFile: baseReadFile }),
    ).resolves.toEqual({
      status: "Unavailable",
      swarmNodeId: nodeId,
      reason: "ContainerInventoryMalformed",
    });
  });
});


describe("private cgroup namespace resolution", () => {
  const scope = `/system.slice/docker-${containerA}.scope`;
  const mockDocker = (args: string[]): Promise<string | null> => {
    if (args[0] === "info") return Promise.resolve(nodeId);
    if (args[0] === "ps") return Promise.resolve(`${containerA}\t${appId}`);
    if (args[0] === "inspect") return Promise.resolve(`${containerA}\t123\t2026-11-02T12:00:00.000Z`);
    return Promise.resolve(null);
  };
  const realpath = (path: string) => Promise.resolve(path);
  function readFor(membership: string) {
    return async (path: string) => {
      if (path.endsWith("/123/cgroup")) return `0::${membership}\n`;
      if (path.endsWith("/cgroup.procs")) throw new Error("PID namespace hides host process IDs");
      return baseReadFile(path);
    };
  }
  it("maps Docker 29 sibling scope without relying on host PID visibility in cgroup.procs", async () => {
    const result = await probeSwarmNodeCapacity({ docker: mockDocker, readFile: readFor(`/../docker-${containerA}.scope`), realpath });
    expect(result.status).toBe("Observed");
    if (result.status === "Observed") expect(result.containers[0]?.memoryCurrentBytes).toBe("1073741824");
  });
  it("rejects traversal and mismatched Docker container identity", async () => {
    for (const membership of [
      `/../../docker-${containerA}.scope`,
      `/../docker-${containerB}.scope`,
    ]) {
      const result = await probeSwarmNodeCapacity({ docker: mockDocker, readFile: readFor(membership), realpath });
      expect(result).toMatchObject({ status: "Unavailable", reason: "ContainerTelemetryUnavailable" });
    }
  });
  it("rejects mid-sample membership changes even with unchanged Docker inspect", async () => {
    let reads = 0;
    const readFile = async (path: string): Promise<string> => {
      if (path.endsWith("/123/cgroup")) {
        reads += 1;
        return reads === 1 ? `0::/../docker-${containerA}.scope\n` : `0::/../docker-${containerB}.scope\n`;
      }
      return baseReadFile(path);
    };
    const result = await probeSwarmNodeCapacity({ docker: mockDocker, readFile, realpath });
    expect(result).toMatchObject({ status: "Unavailable", reason: "ContainerTelemetryUnavailable" });
  });
  it("rejects symlink escape and unexpected cgroup parent", async () => {
    const result = await probeSwarmNodeCapacity({
      docker: mockDocker,
      readFile: readFor(`/../docker-${containerA}.scope`),
      realpath: path => Promise.resolve(path.endsWith(scope) ? "/outside/docker.scope" : path),
    });
    expect(result).toMatchObject({ status: "Unavailable", reason: "ContainerTelemetryUnavailable" });
  });
});

describe("batched capacity identity revalidation", () => {
  function fixture(count: number, changed: "none" | "pid" | "start" | "missing" = "none") {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: (index + 1).toString(16).padStart(64, "0"),
      pid: index + 1000,
    }));
    let inspectCalls = 0;
    const docker = (args: string[]): Promise<string | null> => {
      if (args[0] === "info") return Promise.resolve(nodeId);
      if (args[0] === "ps") return Promise.resolve(rows.map(row => row.id + "\t" + appId).join("\n"));
      if (args[0] === "inspect") {
        inspectCalls += 1;
        expect(args.slice(3)).toEqual(rows.map(row => row.id));
        const sampled = inspectCalls === 2 && changed === "missing" ? rows.slice(1) : rows;
        return Promise.resolve(sampled.map((row, index) => [
          row.id,
          String(row.pid + (inspectCalls === 2 && changed === "pid" && index === 0 ? 1 : 0)),
          inspectCalls === 2 && changed === "start" && index === 0
            ? "2026-11-02T13:00:00.000Z"
            : "2026-11-02T12:00:00.000Z",
        ].join("\t")).join("\n"));
      }
      return Promise.resolve(null);
    };
    const readFile = (path: string): Promise<string> => {
      const match = /\/(\d+)\/cgroup$/.exec(path);
      if (match) return Promise.resolve(`0::/docker/${match[1]}\n`);
      return baseReadFile(path);
    };
    return {
      docker,
      readFile,
      realpath: (path: string) => Promise.resolve(path),
      inspectCount: () => inspectCalls,
    };
  }

  it("uses only two Docker inspect invocations for 256 replicas", async () => {
    const sample = fixture(256);
    const report = await probeSwarmNodeCapacity(sample);
    expect(report.status).toBe("Observed");
    if (report.status === "Observed") expect(report.containers).toHaveLength(256);
    expect(sample.inspectCount()).toBe(2);
  });

  it.each(["pid", "start", "missing"] as const)(
    "fails closed when post-sample Docker identity changes (%s)",
    async change => {
      const sample = fixture(32, change);
      await expect(probeSwarmNodeCapacity(sample)).resolves.toMatchObject({
        status: "Unavailable",
        reason: "ContainerIdentityChanged",
      });
      expect(sample.inspectCount()).toBe(2);
    },
  );
});
