import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src");

function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("v0.2 observed runtime state ownership", () => {
  it("keeps actual replica writes in the runtime reconciler, not action executors", () => {
    expect(source("internal/runtime-drift-reconciler.service.ts")).toContain(
      "actualReplicas: service?.runningReplicas ?? 0",
    );
    expect(source("operations/executors/runtime-operation.executor.ts")).not.toContain(
      "data: { actualReplicas:",
    );
    expect(source("internal/deployment-execution.service.ts")).not.toContain(
      "actualReplicas:",
    );
    expect(source("internal/deployment-recovery.service.ts")).not.toContain(
      "actualReplicas:",
    );
  });

  it("keeps the HTTP API free from live Docker runtime reads", () => {
    expect(source("api.module.ts")).not.toContain("StackRuntimeService");
    expect(source("api.module.ts")).not.toContain("RuntimeDriftReconcilerService");
  });
});
