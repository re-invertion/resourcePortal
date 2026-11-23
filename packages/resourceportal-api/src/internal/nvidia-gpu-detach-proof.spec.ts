import { describe, expect, it } from "vitest";
import { gpuDetachedFromTaskTemplate } from "./stack-rollout.service";

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
});
