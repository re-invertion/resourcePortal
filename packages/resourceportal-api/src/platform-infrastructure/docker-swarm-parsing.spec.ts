import { describe, expect, it } from "vitest";
import { parseDockerNodeInspect } from "./docker-swarm-parsing";

describe("Stage 13 Docker Swarm parsing", () => {
  it("normalizes a Docker manager node inspect payload", () => {
    expect(
      parseDockerNodeInspect({
        ID: "node-1",
        Spec: {
          Role: "manager",
          Availability: "active",
          Labels: {
            "resourceportal.gpu.count": "1",
            "resourceportal.network.capabilities": "overlay,ipv6",
          },
        },
        Description: {
          Hostname: "docker-1",
          Resources: {
            NanoCPUs: 4_000_000_000,
            MemoryBytes: 8_589_934_592,
          },
        },
        Status: { State: "ready" },
      }),
    ).toEqual({
      swarmNodeId: "node-1",
      hostname: "docker-1",
      role: "Manager",
      status: "Ready",
      availability: "Active",
      cpuNano: 4_000_000_000n,
      memoryBytes: 8_589_934_592n,
      labels: {
        "resourceportal.gpu.count": "1",
        "resourceportal.network.capabilities": "overlay,ipv6",
      },
    });
  });

  it("normalizes Docker worker drain and disconnected states", () => {
    expect(
      parseDockerNodeInspect({
        ID: "node-2",
        Spec: { Role: "worker", Availability: "drain", Labels: null },
        Description: {
          Hostname: "docker-2",
          Resources: { NanoCPUs: 2_000_000_000, MemoryBytes: 4_294_967_296 },
        },
        Status: { State: "disconnected" },
      }),
    ).toEqual({
      swarmNodeId: "node-2",
      hostname: "docker-2",
      role: "Worker",
      status: "Disconnected",
      availability: "Drain",
      cpuNano: 2_000_000_000n,
      memoryBytes: 4_294_967_296n,
      labels: {},
    });
  });

  it("rejects malformed Docker node payloads", () => {
    expect(parseDockerNodeInspect({ ID: "node-3" })).toBeNull();
    expect(parseDockerNodeInspect(null)).toBeNull();
  });
});
