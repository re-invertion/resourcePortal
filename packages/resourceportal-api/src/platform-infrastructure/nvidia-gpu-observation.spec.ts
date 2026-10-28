import { describe, expect, it } from "vitest";
import { deriveGpuAllocationStatus, parseNvidiaGpuInventory } from "./nvidia-gpu-observation";

const UUID = "GPU-ecaf0123-1111-2222-3333-0123456789ab";
const gpu = (extra = "") =>
  `${UUID}, NVIDIA GeForce RTX 2080, 00000000:65:00.0, 22528, 550.120, 42, 17, 512${extra}`;

describe("trusted NVIDIA GPU observation", () => {
  it("records actual VRAM instead of model defaults", () => {
    expect(parseNvidiaGpuInventory(gpu())).toEqual([{
      uuid: UUID,
      vendor: "NVIDIA",
      model: "NVIDIA GeForce RTX 2080",
      pciBusId: "00000000:65:00.0",
      memoryBytes: (22528n * 1024n * 1024n).toString(),
      driverVersion: "550.120",
      temperatureCelsius: 42,
      utilizationPercent: 17,
      memoryUsedBytes: (512n * 1024n * 1024n).toString(),
    }]);
  });

  it("handles quoted commas and missing optional sensors", () => {
    const line = `${UUID}, "NVIDIA, Engineering GPU", 00000000:65:00.0, 24576, 560.42.03, N/A, N/A, N/A`;
    expect(parseNvidiaGpuInventory(line)?.[0]).toMatchObject({
      model: "NVIDIA, Engineering GPU",
      temperatureCelsius: null,
      utilizationPercent: null,
      memoryUsedBytes: null,
    });
  });

  it("rejects duplicate UUIDs, incomplete inventory and impossible sensor values", () => {
    expect(parseNvidiaGpuInventory(gpu() + "\n" + gpu())).toBeNull();
    expect(parseNvidiaGpuInventory(gpu().replace(", 22528,", ", -1,"))).toBeNull();
    expect(parseNvidiaGpuInventory(gpu().replace(", 17,", ", 101,"))).toBeNull();
    expect(parseNvidiaGpuInventory(gpu().replace(", 512", ", 32768"))).toBeNull();
    expect(parseNvidiaGpuInventory(gpu().replace(UUID, "GPU-0"))).toBeNull();
    expect(parseNvidiaGpuInventory("")).toBeNull();
  });

  it("does not confuse an unavailable card with a free card, even when allocated", () => {
    expect(deriveGpuAllocationStatus({
      allocated: true, nodeSchedulable: false, runtimeReady: false, compatible: true,
    })).toBe("Allocated");
    expect(deriveGpuAllocationStatus({
      allocated: false, nodeSchedulable: true, runtimeReady: false, compatible: true,
    })).toBe("Unavailable");
    expect(deriveGpuAllocationStatus({
      allocated: false, nodeSchedulable: true, runtimeReady: true, compatible: false,
    })).toBe("Unsupported");
    expect(deriveGpuAllocationStatus({
      allocated: false, nodeSchedulable: true, runtimeReady: true, compatible: true,
    })).toBe("Available");
  });
});
