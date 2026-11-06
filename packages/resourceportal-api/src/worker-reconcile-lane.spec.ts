import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReconcileLane } from "./worker-reconcile-lane";

describe("Gate/Node/Activation high-priority reconciliation lane", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("schedules Gate, Node and proof activation throughout a 365-second unrelated volume scan", async () => {
    const abort = new AbortController();
    const count = {gate: 0, nodeActivation: 0, volume: 0};
    const events: string[] = [];
    // Simulate a 365s filesystem walk that keeps the background lane busy.
    const slow = runReconcileLane([
      {key: "volumeUsage", intervalMs: 60_000, run: async () => {
        count.volume += 1;
        await new Promise<void>(resolve => setTimeout(resolve, 365_000));
      }},
    ], {signal: abort.signal, pollIntervalMs: 5_000});
    const critical = runReconcileLane([
      {key: "gateRuntime", intervalMs: 10_000, run: () => {
        count.gate++; events.push("gate");
        return Promise.resolve();
      }},
      {key: "remoteLanNode", intervalMs: 10_000, run: () => {
        count.nodeActivation++; events.push("node+activation");
        return Promise.resolve();
      }},
    ], {signal: abort.signal, pollIntervalMs: 1_000});
    await vi.advanceTimersByTimeAsync(350_000);
    expect(count.volume).toBe(1);
    expect(count.gate).toBeGreaterThanOrEqual(30);
    expect(count.nodeActivation).toBeGreaterThanOrEqual(30);
    expect(events.slice(0, 2)).toEqual(["gate", "node+activation"]);
    abort.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([slow, critical]);
  });

  it("prevents overlap, reports missed cycles and resumes after a slow task", async () => {
    const abort = new AbortController();
    let concurrent = 0, maximum = 0, runs = 0;
    const metrics: Array<{delayMs: number;missedCycles: number}> = [];
    const loop = runReconcileLane([{
      key: "gateRuntime", intervalMs: 10_000,
      run: async () => {
        concurrent++;
        maximum=Math.max(maximum,concurrent);
        runs++;
        await new Promise<void>(resolve => setTimeout(resolve, 24_000));
        concurrent--;
      },
    }], {
      signal: abort.signal, pollIntervalMs: 1_000,
      onMetric: metric => metrics.push(metric),
    });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(maximum).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(metrics.length).toBeGreaterThanOrEqual(runs);
    expect(metrics.some(metric=>metric.missedCycles >= 2)).toBe(true);
    abort.abort();
    await vi.advanceTimersByTimeAsync(25_000);
    await loop;
  });

  it("recovers from a task error without killing the critical lane or spinning", async () => {
    const abort = new AbortController();
    const errors: unknown[] = [];
    let attempts=0;
    const lane = runReconcileLane([{
      key: "gateRuntime", intervalMs: 10_000, run: () => {
        attempts++;
        return attempts===1 ? Promise.reject(new Error("transient Docker unavailable"))
          : Promise.resolve();
      },
    }], {signal:abort.signal,pollIntervalMs:1000,onError:(_k,e)=>errors.push(e)});
    await vi.advanceTimersByTimeAsync(45_000);
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(errors).toHaveLength(1);
    abort.abort();
    await lane;
  });

  it("stops promptly when there are no running reconciliations", async () => {
    const abort = new AbortController();
    let runs=0;
    const lane=runReconcileLane([{key:"gateRuntime",intervalMs:10_000,
      run:()=>{runs++;return Promise.resolve();}}], {signal:abort.signal,pollIntervalMs:5000});
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await lane;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(runs).toBe(1);
  });
});
