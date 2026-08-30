import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";

const managerNode = {
  swarmNodeId: "node-1",
  hostname: "manager-1",
  role: "Manager" as const,
  status: "Ready" as const,
  availability: "Active" as const,
  cpuNano: 4_000_000_000n,
  memoryBytes: 8_589_934_592n,
  labels: {},
};

const workerNode = {
  swarmNodeId: "node-2",
  hostname: "worker-1",
  role: "Worker" as const,
  status: "Ready" as const,
  availability: "Active" as const,
  cpuNano: 2_000_000_000n,
  memoryBytes: 4_294_967_296n,
  labels: {
    "resourceportal.gpu.count": "1",
    "resourceportal.network.capabilities": "overlay",
  },
};

describe("SwarmInfrastructureService", () => {
  it("reconciles known and newly discovered nodes by Docker node id", async () => {
    const store = {
      listRemoteLocations: vi.fn().mockResolvedValue([
        {
          id: "remote-1",
          swarmNodeId: "node-1",
          hostname: "old-manager-name",
          status: "Ready",
        },
      ]),
      upsertRemoteLocation: vi.fn().mockResolvedValue(undefined),
      markRemoteLocationRemoved: vi.fn().mockResolvedValue(undefined),
      saveCluster: vi.fn().mockResolvedValue(undefined),
      setClusterError: vi.fn().mockResolvedValue(undefined),
    };
    const docker = {
      inspectSwarm: vi.fn().mockResolvedValue({ dockerClusterId: "cluster-1" }),
      listNodes: vi.fn().mockResolvedValue([managerNode, workerNode]),
    };
    const audit = {
      recordDiscovered: vi.fn().mockResolvedValue(undefined),
      recordRemoved: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SwarmInfrastructureService(
      store as never,
      docker as never,
      audit as never,
    );

    const result = await service.reconcile();

    expect(result).toEqual({
      nodeCount: 2,
      managerCount: 1,
      discovered: 1,
      removed: 0,
      health: "Healthy",
    });
    expect(store.upsertRemoteLocation).toHaveBeenCalledTimes(2);
    expect(store.upsertRemoteLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "remote-1",
        swarmNodeId: "node-1",
        hostname: "manager-1",
        gpuCount: 0,
        networkCapabilities: [],
      }),
    );
    expect(store.upsertRemoteLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        swarmNodeId: "node-2",
        gpuCount: 1,
        networkCapabilities: ["overlay"],
      }),
    );
    expect(audit.recordDiscovered).toHaveBeenCalledTimes(1);
    expect(store.saveCluster).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerClusterId: "cluster-1",
        managerCount: 1,
        nodeCount: 2,
        health: "Healthy",
        lastError: null,
      }),
    );
  });

  it("does not remove known nodes when Docker returns an incomplete snapshot", async () => {
    const store = {
      listRemoteLocations: vi.fn().mockResolvedValue([
        { id: "remote-1", swarmNodeId: "node-1", status: "Ready" },
      ]),
      upsertRemoteLocation: vi.fn(),
      markRemoteLocationRemoved: vi.fn(),
      saveCluster: vi.fn(),
      setClusterError: vi.fn().mockResolvedValue(undefined),
    };
    const docker = {
      inspectSwarm: vi.fn().mockResolvedValue({ dockerClusterId: "cluster-1" }),
      listNodes: vi.fn().mockResolvedValue(null),
    };
    const audit = {
      recordReconcileFailed: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SwarmInfrastructureService(
      store as never,
      docker as never,
      audit as never,
    );

    await expect(service.reconcile()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(store.markRemoteLocationRemoved).not.toHaveBeenCalled();
    expect(store.setClusterError).toHaveBeenCalledOnce();
    expect(audit.recordReconcileFailed).toHaveBeenCalledOnce();
  });

  it("does not persist maintenance when Docker availability update fails", async () => {
    const store = {
      getRemoteLocation: vi.fn().mockResolvedValue({
        id: "remote-1",
        swarmNodeId: "node-1",
        hostname: "manager-1",
        status: "Ready",
        availability: "Active",
        health: "Healthy",
        maintenance: false,
      }),
      setRemoteLocationMaintenance: vi.fn(),
    };
    const docker = {
      setNodeAvailability: vi.fn().mockResolvedValue(false),
    };
    const audit = {
      recordMaintenance: vi.fn(),
    };
    const service = new SwarmInfrastructureService(
      store as never,
      docker as never,
      audit as never,
    );

    await expect(
      service.setMaintenance(
        "remote-1",
        true,
        { id: "user-1", displayName: "Platform Admin" } as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.setRemoteLocationMaintenance).not.toHaveBeenCalled();
    expect(audit.recordMaintenance).not.toHaveBeenCalled();
  });

  it("persists drain maintenance after Docker update succeeds", async () => {
    const store = {
      getRemoteLocation: vi.fn().mockResolvedValue({
        id: "remote-1",
        swarmNodeId: "node-1",
        hostname: "manager-1",
        status: "Ready",
        availability: "Active",
        health: "Healthy",
        maintenance: false,
      }),
      setRemoteLocationMaintenance: vi.fn().mockResolvedValue({
        id: "remote-1",
        maintenance: true,
        availability: "Drain",
        health: "Degraded",
      }),
    };
    const docker = {
      setNodeAvailability: vi.fn().mockResolvedValue(true),
    };
    const audit = {
      recordMaintenance: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SwarmInfrastructureService(
      store as never,
      docker as never,
      audit as never,
    );
    const actor = { id: "user-1", displayName: "Platform Admin" } as never;

    const result = await service.setMaintenance("remote-1", true, actor);

    expect(docker.setNodeAvailability).toHaveBeenCalledWith("node-1", "Drain");
    expect(store.setRemoteLocationMaintenance).toHaveBeenCalledWith(
      "remote-1",
      {
        maintenance: true,
        availability: "Drain",
        health: "Degraded",
      },
    );
    expect(audit.recordMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteLocationId: "remote-1",
        enabled: true,
        actor,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ maintenance: true, availability: "Drain" }),
    );
  });
});
