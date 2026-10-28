import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { probeSwarmNodeGpuRuntime } from "./nvidia-gpu-node-probe";

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
