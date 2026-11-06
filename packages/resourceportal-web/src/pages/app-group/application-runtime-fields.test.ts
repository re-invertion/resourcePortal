import { describe, expect, it } from "vitest";
import { advancedApplicationPatch, basicApplicationPatch, computeApplicationPatch, initialAdvancedRuntime } from "./application-runtime-fields";

const legacy = { entrypoint: "/bin/app", workingDir: "/srv", user: "1000", stopGrace: 30 };
const app = {
  name: "runner", image: "registry.example/runner:v1", registryId: "r-1",
  environment: { SHOULD_NOT_CHANGE: "true" }, secrets: [{ id: "secret-1" }],
  volumeAttachments: [{ id: "volume-1" }], cpu: "2", memoryBytes: "536870912",
  command: ["node", "--flag", "some two words"],
  readOnlyRootFilesystem: false,
  healthCheck: { command: "curl -f localhost:8080", intervalSeconds: 11, timeoutSeconds: 4, retries: 2, extra: "preserve" },
  restartPolicy: { condition: "on-failure", delaySeconds: 4, maxAttempts: 3, windowSeconds: 6, internal: "preserve" },
  updatePolicy: { parallelism: 2, delaySeconds: 4, order: "stop-first", internal: "preserve" },
};
describe("scoped SingleApp PATCH payloads", () => {
  it("edits only basics without overwriting runtime, env or attachments", () => {
    expect(basicApplicationPatch({ name: "runner-v2", image: "image:v2", description: "", registryId: "" })).toEqual({
      name: "runner-v2", image: "image:v2", description: null, registryId: null,
    });
    expect(() => basicApplicationPatch({ name: "runner bad", image: "image:v2", description: "", registryId: "" })).toThrow("Name");
  });
  it("validates DTO CPU minimum 0.01 and integer replica/memory constraints", () => {
    expect(() => computeApplicationPatch({ cpu: 0, memoryMiB: 512, desiredReplicas: 1, runtimeState: "Running" })).toThrow(/CPU/);
    expect(() => computeApplicationPatch({ cpu: 129, memoryMiB: 512, desiredReplicas: 1, runtimeState: "Running" })).toThrow(/CPU/);
    expect(() => computeApplicationPatch({ cpu: 0.5, memoryMiB: 64, desiredReplicas: 1, runtimeState: "Running" })).toThrow(/Memory/);
    expect(() => computeApplicationPatch({ cpu: 0.5, memoryMiB: 512, desiredReplicas: 1.5, runtimeState: "Running" })).toThrow(/Replicas/);
    expect(computeApplicationPatch({ cpu: 0.01, memoryMiB: 128, desiredReplicas: 0, runtimeState: "Stopped" })).toEqual({
      cpu: 0.01, memoryBytes: 134217728, desiredReplicas: 0, runtimeState: "Stopped",
    });
  });
  it("keeps each command argv element intact and preserves preexisting JSON policy attributes", () => {
    const state = initialAdvancedRuntime(app);
    expect(state.command).toEqual(["node", "--flag", "some two words"]);
    expect(state.restartMaxAttempts).toBe("3");
    state.readOnlyRootFilesystem = true;
    state.updateOrder = "start-first";
    const patch = advancedApplicationPatch(legacy, state, app);
    expect(patch.command).toEqual(["node", "--flag", "some two words"]);
    expect(patch.readOnlyRootFilesystem).toBe(true);
    expect(patch.healthCheck).toEqual({
      command: "curl -f localhost:8080", intervalSeconds: 11, timeoutSeconds: 4, retries: 2,
      startPeriodSeconds: 0, extra: "preserve",
    });
    expect(patch.restartPolicy).toEqual({ condition: "on-failure", delaySeconds: 4, maxAttempts: 3, windowSeconds: 6, internal: "preserve" });
    expect(patch.updatePolicy).toEqual({ parallelism: 2, delaySeconds: 4, order: "start-first", internal: "preserve" });
    for (const name of ["image", "cpu", "memoryBytes", "registryId", "environment", "secrets", "volumeAttachments", "desiredReplicas"]) {
      expect(patch).not.toHaveProperty(name);
    }
  });
  it("can explicitly clear health checks, optional restart limits and command arguments", () => {
    const state = initialAdvancedRuntime(app);
    state.command = []; state.healthEnabled = false; state.restartMaxAttempts = ""; state.restartWindow = "";
    const patch = advancedApplicationPatch(legacy, state, app);
    expect(patch.command).toEqual([]);
    expect(patch.healthCheck).toEqual({});
    expect(patch.restartPolicy).toEqual({ condition: "on-failure", delaySeconds: 4, internal: "preserve" });
  });
  it("fails closed on invalid command, health or deployment policies", () => {
    const state = initialAdvancedRuntime(app);
    state.command = ["node", ""];
    expect(() => advancedApplicationPatch(legacy, state, app)).toThrow(/command argument/);
    state.command = ["node"]; state.healthEnabled = true; state.healthCommand = "";
    expect(() => advancedApplicationPatch(legacy, state, app)).toThrow(/Health check/);
    state.healthEnabled = false; state.restartMaxAttempts = "-1";
    expect(() => advancedApplicationPatch(legacy, state, app)).toThrow(/nonnegative/);
    state.restartMaxAttempts = ""; state.updateOrder = "unsupported";
    expect(() => advancedApplicationPatch(legacy, state, app)).toThrow(/order/);
  });
});
