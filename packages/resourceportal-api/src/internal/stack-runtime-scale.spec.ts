import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { StackRuntimeService } from "./stack-runtime.service";

const oldId = "abcdefghijklmnopqrstuvwxy";
const freshId = "zyxwvutsrqponmlkjihgfedcba";
const serviceName = "rp_test_app";
const target = [{ stackName: "rp_test", serviceName: "app", replicas: 1 }];
const result = (exitCode: number, stdout = "", stderr = "") =>
  ({ command: "docker mocked", exitCode, stdout, stderr });
const rejected = (ID: string, Error: string) =>
  JSON.stringify({ ID, Error, CurrentState: "Rejected 3 seconds ago", DesiredState: "Shutdown" });

function fixture(before: ReturnType<typeof result>, scale: ReturnType<typeof result>, after: ReturnType<typeof result>) {
  const runtime = new StackRuntimeService({ get: vi.fn() } as unknown as ConfigService);
  const calls: string[][] = [];
  const queue = [before, scale, after];
  (runtime as unknown as { runDocker: (args: string[], timeout?: number) => Promise<ReturnType<typeof result>> }).runDocker =
    vi.fn((args: string[]) => { calls.push(args); return Promise.resolve(queue.shift() ?? result(127)); });
  return { runtime, calls };
}

describe("runtime scale task baseline and privacy (#450)", () => {
  it("reads task IDs before scale and classifies a newly rejected task only", async () => {
    const { runtime, calls } = fixture(result(0, `${oldId}\n`), result(124),
      result(0, `${rejected(oldId, "manifest unknown")}\n${rejected(freshId, "pull access denied: SECRET")}`));
    const output = await runtime.scaleServices(target);
    expect(output[0]).toMatchObject({ exitCode: 124, diagnosticCode: "ImagePullAuthorizationFailed" });
    expect(JSON.stringify(output)).not.toContain("SECRET");
    expect(calls).toEqual([
      ["service", "ps", "--no-trunc", "--format", "{{.ID}}", serviceName],
      ["service", "scale", `${serviceName}=1`],
      ["service", "ps", "--no-trunc", "--format", "{{json .}}", serviceName],
    ]);
  });
  it("does not classify old rejected tasks as the cause of a new scale failure", async () => {
    const { runtime } = fixture(result(0, oldId), result(124), result(0, rejected(oldId, "pull access denied")));
    const output = await runtime.scaleServices(target);
    expect(output[0]?.diagnosticCode).toBe("TaskFailureUnknown");
    expect(output[0]?.stderr).toContain("cause=TaskFailureUnknown");
  });
  it("does not inspect and trust Swarm tasks when the pre-scale baseline failed", async () => {
    const { runtime, calls } = fixture(result(127), result(124), result(0, rejected(freshId, "pull access denied")));
    expect(await runtime.scaleServices(target)).toMatchObject([{ diagnosticCode: "TaskFailureUnknown" }]);
    expect(calls).toHaveLength(2);
  });
});
