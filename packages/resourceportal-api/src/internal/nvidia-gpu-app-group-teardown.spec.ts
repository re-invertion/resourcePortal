import { describe, expect, it, vi } from "vitest";
import { StackRuntimeService } from "./stack-runtime.service";

const groupId = "12345678-1234-4234-8234-123456789abc";
const nodeId = "ku2gbq2sm1b2khra543dtyxfg";
const done = (stdout: string, exitCode = 0) => ({
  command: "docker", stdout, stderr: "", exitCode,
});

const testSubject = (responses: Array<ReturnType<typeof done>>) => {
  const service = Object.create(StackRuntimeService.prototype) as StackRuntimeService;
  const runner = vi.fn().mockImplementation(() => Promise.resolve(responses.shift() ?? done("", 1)));
  Reflect.set(service, "runDocker", runner);
  return { service, runner };
};

describe("App Group GPU cleanup evidence", () => {
  it("accepts confirmed empty services and no active tasks on ready nodes", async () => {
    const { service, runner } = testSubject([
      done(nodeId + "|Ready|Active"), done(""), done(""),
    ]);
    expect(await service.verifyRemovedGpuAppGroupRuntime(groupId)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("recognizes the Docker current-manager node marker without dropping verification", async () => {
    const { service, runner } = testSubject([
      done(nodeId + " *|Ready|Active"), done(""), done(""),
    ]);
    expect(await service.verifyRemovedGpuAppGroupRuntime(groupId)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("denies reuse when a removed service still has a running task", async () => {
    const { service } = testSubject([
      done(nodeId + "|Ready|Active"), done(""),
      done("rp_12345678_1234_4234_8234_123456789abc_worker.1|Running 5 seconds ago"),
    ]);
    expect(await service.verifyRemovedGpuAppGroupRuntime(groupId)).toBe(false);
  });

  it("never releases GPU ownership if a Swarm node is disconnected or drained", async () => {
    for (const unsafe of ["Down|Active", "Ready|Drain", "Unknown|Active"]) {
      const { service, runner } = testSubject([done(nodeId + "|" + unsafe)]);
      expect(await service.verifyRemovedGpuAppGroupRuntime(groupId)).toBe(false);
      expect(runner).toHaveBeenCalledTimes(1);
    }
  });

  it("does not trust a failed or ambiguous global services query", async () => {
    const { service } = testSubject([
      done(nodeId + "|Ready|Active"), done("", 1),
    ]);
    expect(await service.verifyRemovedGpuAppGroupRuntime(groupId)).toBe(false);
  });
});
