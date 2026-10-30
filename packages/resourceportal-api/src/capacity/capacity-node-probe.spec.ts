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
