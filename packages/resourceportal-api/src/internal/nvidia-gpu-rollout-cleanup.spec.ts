import { describe, expect, it, vi } from "vitest";
import { StackRolloutService } from "./stack-rollout.service";

const STACK = "rp_12345678_1234_4234_8234_123456789abc";
const SERVICE = "gpu_app";
const NODE = "ku2gbq2sm1b2khra543dtyxfg";
const output = (stdout: string, exitCode = 0) => ({
  stdout, stderr: "", exitCode,
});

function probe(responses: Array<ReturnType<typeof output>>) {
  const service = Object.create(StackRolloutService.prototype) as StackRolloutService;
  Reflect.set(service, "config", { get: () => undefined });
  const docker = vi.fn(() => Promise.resolve(responses.shift() ?? output("", 1)));
  Reflect.set(service, "runDocker", docker);
  return { service, docker };
}

describe("verified cleanup of removed GPU-backed Swarm services", () => {
  it("accepts only globally absent services and fully terminated GPU tasks", async () => {
    const { service, docker } = probe([
      output(NODE + " *|Ready|Active"),
      output(STACK + "_cpu_app"),
      output(STACK + "_" + SERVICE + ".1|Shutdown 3 seconds ago"),
    ]);
    expect(await service.verifyRemovedGpuServiceTasks(STACK, [SERVICE])).toBe(true);
    expect(docker).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a GPU task still runs although Swarm removed its service", async () => {
    const { service } = probe([
      output(NODE + "|Ready|Active"), output(""),
      output(STACK + "_" + SERVICE + ".1|Running 5 seconds ago"),
    ]);
    expect(await service.verifyRemovedGpuServiceTasks(STACK, [SERVICE])).toBe(false);
  });

  it("rejects unexpected live service, offline node, or failed inspection", async () => {
    for (const responses of [
      [output(NODE + "|Ready|Active"), output(STACK + "_" + SERVICE)],
      [output(NODE + "|Down|Active")],
      [output(NODE + "|Ready|Drain")],
      [output(NODE + "|Ready|Active"), output("", 1)],
    ]) {
      const { service } = probe(responses);
      expect(await service.verifyRemovedGpuServiceTasks(STACK, [SERVICE])).toBe(false);
    }
  });

  it("does not inspect or block conventional CPU-only cleanup", async () => {
    const { service, docker } = probe([]);
    expect(await service.verifyRemovedGpuServiceTasks(STACK, [])).toBe(true);
    expect(docker).not.toHaveBeenCalled();
  });
});
