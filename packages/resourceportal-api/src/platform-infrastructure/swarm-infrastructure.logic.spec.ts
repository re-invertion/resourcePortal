import { describe, expect, it } from "vitest";
import {
  deriveRemoteLocationHealth,
  deriveSchedulableCapacity,
  deriveSwarmClusterHealth,
  parseNodeCapabilities,
  planInventoryReconciliation,
} from "./swarm-infrastructure.logic";

describe("Stage 13 platform infrastructure logic", () => {
  it("maps a Ready Active node to Healthy", () => {
    expect(deriveRemoteLocationHealth("Ready", "Active")).toBe("Healthy");
  });

  it("maps a Ready drained node to Degraded", () => {
    expect(deriveRemoteLocationHealth("Ready", "Drain")).toBe("Degraded");
  });

  it("maps unavailable nodes to Unhealthy", () => {
    expect(deriveRemoteLocationHealth("Down", "Active")).toBe("Unhealthy");
    expect(deriveRemoteLocationHealth("Disconnected", "Active")).toBe(
      "Unhealthy",
    );
    expect(deriveRemoteLocationHealth("Removed", "Drain")).toBe("Unhealthy");
  });

  it("maps an unknown node state to Unknown", () => {
    expect(deriveRemoteLocationHealth("Unknown", "Active")).toBe("Unknown");
  });

  it("exposes total CPU and RAM as schedulable available capacity for Ready Active nodes", () => {
    expect(
      deriveSchedulableCapacity(
        "Ready",
        "Active",
        4_000_000_000n,
        8_589_934_592n,
      ),
    ).toEqual({
      availableCpuNano: 4_000_000_000n,
      availableMemoryBytes: 8_589_934_592n,
    });
  });

  it("reports zero schedulable available capacity for drained, paused, or unavailable nodes", () => {
    for (const [status, availability] of [
      ["Ready", "Drain"],
      ["Ready", "Pause"],
      ["Down", "Active"],
    ] as const) {
      expect(
        deriveSchedulableCapacity(
          status,
          availability,
          4_000_000_000n,
          8_589_934_592n,
        ),
      ).toEqual({
        availableCpuNano: 0n,
        availableMemoryBytes: 0n,
      });
    }
  });

  it("derives Healthy cluster when a ready manager exists and every node is ready", () => {
    expect(
      deriveSwarmClusterHealth([
        { role: "Manager", status: "Ready" },
        { role: "Worker", status: "Ready" },
      ]),
    ).toBe("Healthy");
  });

  it("derives Degraded cluster when a ready manager exists but another node is not ready", () => {
    expect(
      deriveSwarmClusterHealth([
        { role: "Manager", status: "Ready" },
        { role: "Worker", status: "Down" },
      ]),
    ).toBe("Degraded");
  });

  it("derives Unhealthy cluster when no ready manager exists", () => {
    expect(
      deriveSwarmClusterHealth([
        { role: "Manager", status: "Down" },
        { role: "Worker", status: "Ready" },
      ]),
    ).toBe("Unhealthy");
    expect(deriveSwarmClusterHealth([])).toBe("Unhealthy");
  });

  it("parses deterministic GPU and network capability labels", () => {
    expect(
      parseNodeCapabilities({
        "resourceportal.gpu.count": "2",
        "resourceportal.network.capabilities": "overlay, ipv6,overlay",
      }),
    ).toEqual({
      gpuCount: 2,
      networkCapabilities: ["ipv6", "overlay"],
    });
  });

  it("treats invalid capability labels as empty capacity", () => {
    expect(
      parseNodeCapabilities({
        "resourceportal.gpu.count": "not-a-number",
        "resourceportal.network.capabilities": " , ",
      }),
    ).toEqual({
      gpuCount: 0,
      networkCapabilities: [],
    });
  });

  it("reuses a Remote Location identity when the Docker node remains the same", () => {
    const plan = planInventoryReconciliation(
      [
        {
          id: "remote-1",
          swarmNodeId: "node-1",
          status: "Ready",
        },
      ],
      [{ swarmNodeId: "node-1" }],
    );

    expect(plan.observations).toEqual([
      {
        swarmNodeId: "node-1",
        remoteLocationId: "remote-1",
        discovered: false,
      },
    ]);
    expect(plan.removed).toEqual([]);
  });

  it("marks only previously known missing nodes as removed", () => {
    const plan = planInventoryReconciliation(
      [
        { id: "remote-1", swarmNodeId: "node-1", status: "Ready" },
        { id: "remote-2", swarmNodeId: "node-2", status: "Removed" },
      ],
      [{ swarmNodeId: "node-3" }],
    );

    expect(plan.observations).toEqual([
      {
        swarmNodeId: "node-3",
        remoteLocationId: null,
        discovered: true,
      },
    ]);
    expect(plan.removed).toEqual([
      { id: "remote-1", swarmNodeId: "node-1" },
    ]);
  });
});
