import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { probeSwarmNodeGpuRuntime, probeSwarmNodeGpuContainerUsage } from "./nvidia-gpu-node-probe";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const SWARM_NODE_ID = "ku2gbq2sm1b2khra543dtyxfg";
type DockerAnswer = { text: string; exitCode?: number };

describe("trusted NVIDIA Swarm node runtime probe", () => {
  let answers: DockerAnswer[];
  const invocations: string[][] = [];

  beforeEach(() => {
    answers = [];
    invocations.length = 0;
    vi.mocked(spawn).mockImplementation((_binary, argumentsList) => {
      invocations.push(argumentsList as string[]);
      const answer = answers.shift() ?? { text: "", exitCode: 1 };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(answer.text, "utf8"));
        child.emit("close", answer.exitCode ?? 0);
      });
      return child as never;
    });
  });

  it("fails closed on a Swarm node using runc as default despite a GPU toolkit", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: "runc" });
    await expect(probeSwarmNodeGpuRuntime()).resolves.toEqual({
      swarmNodeId: SWARM_NODE_ID,
      status: "Unavailable",
      reason: "NvidiaNotDefaultRuntime",
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toContain("{{.DefaultRuntime}}");
  });

  it("never pulls mutable images or starts a runtime probe when immutable image is not cached", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: "nvidia" },
      { text: "", exitCode: 1 });
    await expect(probeSwarmNodeGpuRuntime()).resolves.toEqual({
      swarmNodeId: SWARM_NODE_ID,
      status: "Unavailable",
      reason: "GpuProbeImageNotInstalled",
    });
    expect(invocations).toHaveLength(3);
    expect(invocations.every((args) => args[0] !== "pull" && args[0] !== "run")).toBe(true);
  });
});

describe("node-local proof of GPU container absence (#378)", () => {
  const uuid = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const containerId = "a".repeat(64);
  let answers: DockerAnswer[];
  const invocations: string[][] = [];
  beforeEach(() => {
    answers = [];
    invocations.length = 0;
    vi.mocked(spawn).mockImplementation((_binary, argumentsList) => {
      invocations.push(argumentsList as string[]);
      const answer = answers.shift() ?? { text: "", exitCode: 1 };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(answer.text, "utf8"));
        child.emit("close", answer.exitCode ?? 0);
      });
      return child as never;
    });
  });

  it("accepts a fresh successful empty local Docker container census", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: "" });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toEqual({
      swarmNodeId: SWARM_NODE_ID, status: "Verified",
      busyAnyGpu: false, containers: [],
    });
    expect(invocations.map((args) => args[0])).toEqual(["info", "ps"]);
  });

  it("accepts Docker's null DeviceRequests/Devices for CPU-only containers", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: containerId }, {
      text: JSON.stringify({
        State: { Running: true },
        Config: { Env: [], Labels: null },
        HostConfig: { DeviceRequests: null, Devices: null },
      }),
    });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toEqual({
      swarmNodeId: SWARM_NODE_ID, status: "Verified",
      busyAnyGpu: false, containers: [],
    });
  });

  it("detects an active RP GPU task by pinned UUID and service identity", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: containerId }, {
      text: JSON.stringify({
        State: { Running: true },
        Config: {
          Env: ["NVIDIA_VISIBLE_DEVICES=" + uuid],
          Labels: { "com.docker.swarm.service.name": "rp_group_gpu_app" },
        },
        HostConfig: { DeviceRequests: [], Devices: [] },
      }),
    });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toEqual({
      swarmNodeId: SWARM_NODE_ID, status: "Verified", busyAnyGpu: false,
      containers: [{ uuid, serviceName: "rp_group_gpu_app" }],
    });
  });

  it("conservatively treats an all-GPU Docker device request as occupied", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: containerId }, {
      text: JSON.stringify({
        State: { Running: true },
        Config: { Env: [], Labels: {} },
        HostConfig: { DeviceRequests: [{ Driver: "nvidia", DeviceIDs: [] }] },
      }),
    });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toMatchObject({
      status: "Verified", busyAnyGpu: true, containers: [],
    });
  });

  it("never labels an inventory/inspect failure as verified idle", async () => {
    answers.push({ text: SWARM_NODE_ID }, { text: containerId },
      { text: "", exitCode: 1 });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toMatchObject({
      status: "Unavailable", reason: "GpuContainerInspectUnavailable",
    });
    answers.push({ text: SWARM_NODE_ID }, { text: "", exitCode: 1 });
    await expect(probeSwarmNodeGpuContainerUsage()).resolves.toMatchObject({
      status: "Unavailable", reason: "GpuContainerInventoryUnavailable",
    });
  });
});
