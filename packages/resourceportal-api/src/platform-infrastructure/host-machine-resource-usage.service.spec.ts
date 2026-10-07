import { describe, expect, it } from "vitest";
import {
  parseCpuCount,
  parseCpuSnapshot,
  parseMemoryInfo,
} from "./host-machine-resource-usage.service";

describe("host machine resource usage parsing", () => {
  it("parses aggregate CPU counters without double-counting guest time", () => {
    const input = [
      "cpu  100 20 30 400 10 5 6 7 8 9",
      "cpu0 50 10 15 200 5 2 3 4 4 5",
      "cpu1 50 10 15 200 5 3 3 3 4 4",
      "",
    ].join("\n");

    expect(parseCpuSnapshot(input)).toEqual({
      idle: 410n,
      total: 578n,
    });
    expect(parseCpuCount(input)).toBe(2);
  });

  it("uses MemAvailable to report actual host memory consumption", () => {
    const memory = parseMemoryInfo(
      [
        "MemTotal:       1000000 kB",
        "MemFree:         100000 kB",
        "MemAvailable:    400000 kB",
        "",
      ].join("\n"),
    );

    expect(memory.totalBytes).toBe(1_024_000_000n);
    expect(memory.availableBytes).toBe(409_600_000n);
    expect(memory.usedBytes).toBe(614_400_000n);
  });
});
