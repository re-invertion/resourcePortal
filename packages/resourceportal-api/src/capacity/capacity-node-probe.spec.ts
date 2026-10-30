import { describe, expect, it } from "vitest";
import { parseMeminfo, parsePressure } from "./capacity-node-probe";

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
