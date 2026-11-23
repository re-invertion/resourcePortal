import { describe, expect, it } from "vitest";
import { gpuDetachedFromTaskTemplate, StackRolloutService } from "./stack-rollout.service";

function taskTemplate(env: string[], genericResources?: unknown) {
  return JSON.stringify({
    ContainerSpec: { Env: env },
    Resources: { Reservations: { GenericResources: genericResources } },
  });
}

describe("GPU release Swarm task proof (#526)", () => {
  it("accepts only tasks with NVIDIA hidden and no generic-resource reservation", () => {
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["FOO=bar", "NVIDIA_VISIBLE_DEVICES=void"], []))).toBe(true);
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["NVIDIA_VISIBLE_DEVICES=void"]))).toBe(true);
  });

  it("rejects stale GPU-visible tasks and generic GPU reservations", () => {
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["NVIDIA_VISIBLE_DEVICES=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]))).toBe(false);
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["NVIDIA_VISIBLE_DEVICES=all"]))).toBe(false);
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["NVIDIA_VISIBLE_DEVICES=void", "NVIDIA_VISIBLE_DEVICES=all"]))).toBe(false);
    expect(gpuDetachedFromTaskTemplate(taskTemplate(["NVIDIA_VISIBLE_DEVICES=void"], [
      { DiscreteResourceSpec: { Kind: "NVIDIA-GPU", Value: 1 } },
    ]))).toBe(false);
  });

  it("fails closed when task specification cannot be proven safe", () => {
    expect(gpuDetachedFromTaskTemplate("")).toBe(false);
    expect(gpuDetachedFromTaskTemplate("{}")).toBe(false);
    expect(gpuDetachedFromTaskTemplate(taskTemplate([]))).toBe(false);
    expect(gpuDetachedFromTaskTemplate(JSON.stringify({ ContainerSpec: { Env: "void" } }))).toBe(false);
  });
  it("refuses release while an old GPU-backed task is running", async () => {
    const service = Object.create(StackRolloutService.prototype) as StackRolloutService;
    (service as unknown as { config: unknown }).config = { get: () => undefined };
    (service as unknown as { runDocker: (args: string[]) => Promise<unknown> }).runDocker = async (args) => {
      if (args[0] === "node" && args[1] === "ls") return {
        exitCode: 0, stdout: "abcdefghijklmnopqrstuvwxy|Ready|Active", stderr: "",
      };
      if (args[0] === "service" && args[1] === "inspect") return {
        exitCode: 0, stdout: taskTemplate(["NVIDIA_VISIBLE_DEVICES=void"]), stderr: "",
      };
      if (args[0] === "node" && args[1] === "ps") return {
        exitCode: 0, stdout: "abcdefghijklmnopqrstuvwxyz|stack_source.1.old|Running 1 minute ago", stderr: "",
      };
      return {
        exitCode: 0, stdout: taskTemplate(["NVIDIA_VISIBLE_DEVICES=all"]), stderr: "",
      };
    };
    expect(await service.verifyDetachedGpuServiceTasks("stack", ["source"])).toBe(false);
  });

  it("permits a running CPU-only successor after the old task exits", async () => {
    const service = Object.create(StackRolloutService.prototype) as StackRolloutService;
    (service as unknown as { config: unknown }).config = { get: () => undefined };
    (service as unknown as { runDocker: (args: string[]) => Promise<unknown> }).runDocker = async (args) => {
      if (args[0] === "node" && args[1] === "ls") return {
        exitCode: 0, stdout: "abcdefghijklmnopqrstuvwxy|Ready|Active", stderr: "",
      };
      if (args[0] === "node" && args[1] === "ps") return {
        exitCode: 0,
        stdout: "abcdefghijklmnopqrstuvwxyz|stack_source.1.new|Running 10 seconds ago\n" +
          "zyxwvutsrqponmlkjihgfedcba|stack_source.1.old|Shutdown 20 seconds ago",
        stderr: "",
      };
      return {
        exitCode: 0, stdout: taskTemplate(["NVIDIA_VISIBLE_DEVICES=void"]), stderr: "",
      };
    };
    expect(await service.verifyDetachedGpuServiceTasks("stack", ["source"])).toBe(true);
  });

});
