import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { SwarmGpuNodeProbeRouter } from "./swarm-gpu-node-probe-router";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const id = "ku2gbq2sm1b2khra543dtyxfg";
const gpu = {
  uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  vendor: "NVIDIA", model: "RTX 2080", pciBusId: "00000000:01:00.0",
  memoryBytes: "123456789", memoryUsedBytes: "0", driverVersion: "550.54.14",
  temperatureCelsius: null, utilizationPercent: 0,
};

function makeRouter(token = "internal_worker_token_1234567890") {
  const config = { get: (key: string) => key === "INTERNAL_WORKER_TOKEN" ? token :
    key === "RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME" ? "rp" : undefined };
  return new SwarmGpuNodeProbeRouter(config as never);
}

describe("authenticated multi-node NVIDIA observations", () => {
  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "10.0.0.11", family: 4 },
      { address: "10.0.0.12", family: 4 },
    ] as never);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses discovery when the private worker credential is absent", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await makeRouter("").collect()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not trust duplicate conflicting identities from two probe endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: "Observed", swarmNodeId: id, devices: [gpu] }), {
        status: 200,
      }))));
    expect(await makeRouter().collect()).toEqual([]);
  });

  it("rejects malformed GPU observations and returns only authenticated valid reports", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string) => Promise.resolve(new Response(JSON.stringify(
      input.includes(".11:") ?
        { status: "Observed", swarmNodeId: id, devices: [{ ...gpu, uuid: "GPU-not-a-uuid" }] } :
        { status: "Observed", swarmNodeId: id, devices: [gpu] },
    ), { status: 200 }))));
    expect(await makeRouter().collect()).toEqual([
      { status: "Observed", swarmNodeId: id, devices: [gpu] },
    ]);
  });
});

describe("authenticated GPU recovery usage proof (#378)", () => {
  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "10.0.0.11", family: 4 },
      { address: "10.0.0.12", family: 4 },
    ] as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves explicit NVIDIA runtime failure reasons from the agent", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve(new Response(JSON.stringify(url.includes(".11:")
        ? { status: "Unavailable", swarmNodeId: id,
            reason: "NvidiaNotDefaultRuntime" }
        : { status: "Unavailable", swarmNodeId: "ku2gbq2sm1b2khra543dtyxfh",
            reason: "GpuProbeImageNotInstalled" }), { status: 200 }))));
    expect(await makeRouter().collect()).toEqual([
      { status: "Unavailable", swarmNodeId: id, devices: [],
        reason: "NvidiaNotDefaultRuntime" },
      { status: "Unavailable", swarmNodeId: "ku2gbq2sm1b2khra543dtyxfh",
        devices: [], reason: "GpuProbeImageNotInstalled" },
    ]);
  });

  it("returns authenticated node-local GPU containers without unverified peers", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve(new Response(JSON.stringify(url.includes(".11:")
        ? { swarmNodeId: id, status: "Verified", busyAnyGpu: false,
            containers: [{ serviceName: "rp_group_gpu_app", uuid: gpu.uuid }] }
        : { swarmNodeId: "ku2gbq2sm1b2khra543dtyxfh", status: "Verified",
            busyAnyGpu: false, containers: [{ uuid: "invalid", serviceName: null }] }),
      { status: 200 }))));
    expect(await makeRouter().collectUsage()).toEqual([
      { swarmNodeId: id, status: "Verified", busyAnyGpu: false,
        containers: [{ serviceName: "rp_group_gpu_app", uuid: gpu.uuid }] },
    ]);
  });

  it("rejects duplicate agent identities for recovery proofs", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      swarmNodeId: id, status: "Verified", busyAnyGpu: false, containers: [],
    }), { status: 200 }))));
    expect(await makeRouter().collectUsage()).toEqual([]);
  });
});
