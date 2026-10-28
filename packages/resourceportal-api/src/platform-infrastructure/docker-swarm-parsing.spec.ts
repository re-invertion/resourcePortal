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

  it("extracts distinct NVIDIA UUID generic resources from the trusted daemon description", () => {
    const gpuA = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const gpuB = "GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    const base = {
      ID: "node-1", Spec: { Role: "manager", Availability: "active" },
      Description: {
        Hostname: "nvidia-node", Resources: {
          NanoCPUs: 8_000_000_000, MemoryBytes: 17_179_869_184,
          GenericResources: [
            { NamedResourceSpec: { Kind: "NVIDIA-GPU", Value: gpuB } },
            { NamedResourceSpec: { Kind: "NVIDIA-GPU", Value: gpuA } },
            { DiscreteResourceSpec: { Kind: "OTHER", Value: 1 } },
          ],
        },
      },
      Status: { State: "ready" },
    };
    expect(parseDockerNodeInspect(base)?.gpuUuids).toEqual([gpuA, gpuB]);
    const duplicate = structuredClone(base);
    duplicate.Description.Resources.GenericResources[1] = {
      NamedResourceSpec: { Kind: "NVIDIA-GPU", Value: gpuB },
    };
    expect(parseDockerNodeInspect(duplicate)?.gpuUuids).toBeUndefined();
  });

  it("rejects malformed Docker node payloads", () => {
    expect(parseDockerNodeInspect({ ID: "node-3" })).toBeNull();
    expect(parseDockerNodeInspect(null)).toBeNull();
  });
});
