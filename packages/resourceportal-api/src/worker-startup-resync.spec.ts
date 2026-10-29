import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 Worker startup resync", () => {
  const source = readFileSync(resolve(process.cwd(), "src/worker.runner.ts"), "utf8");

  it("starts operation polling independently before potentially slow startup resync", () => {
    const operationLoop = source.indexOf("operationLoop = (async () => {");
    const processOperation = source.indexOf("operations.processNext(workerId, leaseSeconds)");
    const fullResync = source.indexOf('startupReconcile("drift", () => drift.reconcileAll())');
    expect(operationLoop).toBeGreaterThan(-1);
    expect(processOperation).toBeGreaterThan(operationLoop);
    expect(fullResync).toBeGreaterThan(processOperation);
    // One-shot workers must still wait for the operation to finish; normal
    // workers must not block their operation poller on startup reconciliation.
    const between = source.slice(operationLoop, fullResync);
    expect(between).toContain("if (once) {\n      await operationLoop;");
    expect(between).toContain("if (!once) {");
  });

  it("uses bounded periodic reconciliation after the startup full resync", () => {
    expect(source).toContain('reconcile("drift", () => drift.reconcileBatch())');
  });
});
