import { describe, expect, it } from "vitest";
import {
  projectedCapacityFits,
  snapshotDemand,
  type CapacitySnapshot,
} from "./capacity.logic";

function snapshot(
  overrides?: Partial<CapacitySnapshot["appGroup"]> & {
    singleApps?: CapacitySnapshot["singleApps"];
  },
): CapacitySnapshot {
  return {
    appGroup: {
      runtimeState: overrides?.runtimeState ?? "Running",
    },
    singleApps:
      overrides?.singleApps ?? [
        {
          runtimeState: "Running",
          desiredReplicas: 2,
          resources: { cpu: "1.25", memoryBytes: "1073741824", gpu: 0 },
        },
      ],
  };
}

describe("Stage 15 capacity logic", () => {
  it("converts CPU decimals to Docker NanoCPU bigint and multiplies by effective replicas", () => {
    expect(snapshotDemand(snapshot())).toEqual({
      cpuNano: 2_500_000_000n,
      memoryBytes: 2_147_483_648n,
    });
  });

  it("counts a stopped AppGroup as zero demand", () => {
    expect(snapshotDemand(snapshot({ runtimeState: "Stopped" }))).toEqual({
      cpuNano: 0n,
      memoryBytes: 0n,
    });
  });

  it("counts a stopped SingleApp as zero demand", () => {
    expect(
      snapshotDemand(
        snapshot({
          singleApps: [
            {
              runtimeState: "Stopped",
              desiredReplicas: 5,
              resources: { cpu: "4", memoryBytes: "8589934592", gpu: 0 },
            },
          ],
        }),
      ),
    ).toEqual({ cpuNano: 0n, memoryBytes: 0n });
  });

  it("rejects projected CPU or memory above platform supply", () => {
    expect(
      projectedCapacityFits(
        { cpuNano: 4_000_000_000n, memoryBytes: 8_000n },
        { cpuNano: 3_000_000_000n, memoryBytes: 2_000n },
        { cpuNano: 1_500_000_000n, memoryBytes: 1_000n },
      ),
    ).toEqual({ fits: false, resource: "cpu" });

    expect(
      projectedCapacityFits(
        { cpuNano: 4_000_000_000n, memoryBytes: 8_000n },
        { cpuNano: 1_000_000_000n, memoryBytes: 7_500n },
        { cpuNano: 1_000_000_000n, memoryBytes: 1_000n },
      ),
    ).toEqual({ fits: false, resource: "memory" });
  });

  it("accepts projected demand that fits both CPU and memory", () => {
    expect(
      projectedCapacityFits(
        { cpuNano: 4_000_000_000n, memoryBytes: 8_000n },
        { cpuNano: 1_000_000_000n, memoryBytes: 2_000n },
        { cpuNano: 2_000_000_000n, memoryBytes: 3_000n },
      ),
    ).toEqual({ fits: true });
  });
});
