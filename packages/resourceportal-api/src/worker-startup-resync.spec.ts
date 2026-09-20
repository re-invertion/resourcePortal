import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.2 Worker startup resync", () => {
  const source = readFileSync(resolve(process.cwd(), "src/worker.runner.ts"), "utf8");

  it("does a full runtime resync before processing queued Operations", () => {
    const fullResync = source.indexOf('startupReconcile("drift", () => drift.reconcileAll())');
    const processOperation = source.indexOf("operations.processNext(workerId, leaseSeconds)");
    expect(fullResync).toBeGreaterThan(-1);
    expect(processOperation).toBeGreaterThan(fullResync);
  });

  it("uses bounded periodic reconciliation after the startup full resync", () => {
    expect(source).toContain('reconcile("drift", () => drift.reconcileBatch())');
  });
});
