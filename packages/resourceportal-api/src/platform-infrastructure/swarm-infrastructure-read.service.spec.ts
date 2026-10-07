import { describe, expect, it, vi } from "vitest";
import { SwarmInfrastructureReadService } from "./swarm-infrastructure-read.service";

function remote(overrides: Record<string, unknown> = {}) {
  return {
    id: "remote-1",
    swarmNodeId: "node-1",
    hostname: "worker-1",
    role: "Worker",
    status: "Ready",
    availability: "Active",
    health: "Healthy",
    maintenance: false,
    cpuNano: 4_000_000_000n,
    availableCpuNano: 4_000_000_000n,
    memoryBytes: 8_589_934_592n,
    availableMemoryBytes: 8_589_934_592n,
    gpuCount: 1,
    networkCapabilities: ["overlay"],
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function liveHost(overrides: Record<string, unknown> = {}) {
  return {
    cpuUsedRatio: 0.25,
    cpuCount: 6,
    memoryUsedBytes: 3_221_225_472n,
    memoryTotalBytes: 12_884_901_888n,
    observedAt: new Date("2026-10-06T22:00:00.000Z"),
    ...overrides,
  };
}

describe("SwarmInfrastructureReadService", () => {
  it("hides removed Remote Locations from platform inventory", async () => {
    const store = {
      listRemoteLocations: vi.fn().mockResolvedValue([
        remote(),
        remote({ id: "remote-old", swarmNodeId: "node-old", status: "Removed" }),
      ]),
    };
    const prisma = { singleApp: { findMany: vi.fn() }, storageBackend: { findMany: vi.fn() } };
    const service = new SwarmInfrastructureReadService(
      store as never,
      prisma as never,
      { observe: vi.fn().mockResolvedValue(liveHost()) },
    );

    const result = await service.listRemoteLocations();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "remote-1", cpuNano: "4000000000" });
  });

  it("reports actual host CPU and memory usage instead of configured app allocation", async () => {
    const store = {
      listRemoteLocations: vi.fn().mockResolvedValue([remote()]),
    };
    const prisma = {
      singleApp: {
        findMany: vi.fn().mockResolvedValue([
          { cpu: 0.5, memoryBytes: 536_870_912n, gpu: 0, actualReplicas: 2 },
          { cpu: 1, memoryBytes: 1_073_741_824n, gpu: 1, actualReplicas: 1 },
        ]),
      },
      storageBackend: {
        findMany: vi.fn().mockResolvedValue([
          { capacityTotal: 10_000n, capacityAvailable: 4_000n },
          { capacityTotal: 5_000n, capacityAvailable: 2_000n },
        ]),
      },
    };
    const service = new SwarmInfrastructureReadService(
      store as never,
      prisma as never,
      { observe: vi.fn().mockResolvedValue(liveHost()) },
    );

    const result = await service.getResourceUsage();

    expect(result).toMatchObject({
      cpuUsedNano: "1500000000",
      cpuTotalNano: "6000000000",
      memoryUsedBytes: "3221225472",
      memoryTotalBytes: "12884901888",
      gpuUsed: 1,
      gpuTotal: 1,
      storageUsedBytes: "9000",
      storageTotalBytes: "15000",
      runningReplicas: 3,
      liveUsageAvailable: true,
      liveUsageScope: "host",
      liveUsageReason: null,
      observedAt: "2026-10-06T22:00:00.000Z",
    });
  });

  it("does not present configured allocation as live usage for a multi-node cluster", async () => {
    const store = {
      listRemoteLocations: vi.fn().mockResolvedValue([
        remote(),
        remote({
          id: "remote-2",
          swarmNodeId: "node-2",
          cpuNano: 2_000_000_000n,
          memoryBytes: 4_294_967_296n,
          gpuCount: 0,
        }),
      ]),
    };
    const prisma = {
      singleApp: { findMany: vi.fn().mockResolvedValue([]) },
      storageBackend: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new SwarmInfrastructureReadService(
      store as never,
      prisma as never,
      { observe: vi.fn().mockResolvedValue(liveHost()) },
    );

    const result = await service.getResourceUsage();

    expect(result.cpuUsedNano).toBeNull();
    expect(result.memoryUsedBytes).toBeNull();
    expect(result.liveUsageAvailable).toBe(false);
    expect(result.liveUsageReason).toContain("per-node telemetry");
    expect(result.cpuTotalNano).toBe("6000000000");
    expect(result.memoryTotalBytes).toBe("12884901888");
  });
});
