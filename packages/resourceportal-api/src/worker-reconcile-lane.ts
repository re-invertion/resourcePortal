/** Independent serial lanes prevent a slow telemetry operation from starving
 * Gate, Node or Activation. Tasks in the same lane are strictly non-overlapping.
 * The abortable sleep immediately stops new work on SIGTERM/restart.
 */
export type ReconcileLaneTask = {
  key: string;
  intervalMs: number;
  run: () => Promise<unknown>;
};
export type ReconcileLaneMetric = {
  key: string;
  delayMs: number;
  missedCycles: number;
  durationMs?: number;
};

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function runReconcileLane(
  tasks: readonly ReconcileLaneTask[],
  options: {
    signal: AbortSignal;
    pollIntervalMs: number;
    onMetric?: (metric: ReconcileLaneMetric) => void;
    onError?: (key: string, error: unknown) => void;
  },
): Promise<void> {
  const keys = new Set<string>();
  for (const task of tasks) {
    if (!task.key || keys.has(task.key) || !Number.isSafeInteger(task.intervalMs) ||
        task.intervalMs <= 0)
      throw new Error("Invalid or duplicate reconciliation lane key");
    keys.add(task.key);
  }
  const next = new Map(tasks.map(task => [task.key, Date.now()]));
  while (!options.signal.aborted) {
    for (const task of tasks) {
      if (options.signal.aborted) break;
      const dueAt = next.get(task.key)!;
      const now = Date.now();
      if (now < dueAt) continue;
      const delayMs = Math.max(0, now - dueAt);
      const missedCycles = Math.floor(delayMs / task.intervalMs);
      options.onMetric?.({ key: task.key, delayMs, missedCycles });
      const startedAt = Date.now();
      try {
        await task.run();
      } catch (error) {
        options.onError?.(task.key, error);
      } finally {
        const durationMs = Math.max(0, Date.now() - startedAt);
        const overrunCycles = Math.floor(durationMs / task.intervalMs);
        if (overrunCycles) {
          options.onMetric?.({
            key: task.key,
            delayMs: 0,
            missedCycles: overrunCycles,
            durationMs,
          });
        }
        // Do not pile up delayed runs; schedule the next run only after the
        // previous run settles. One task cannot overlap itself.
        next.set(task.key, Date.now() + task.intervalMs);
      }
    }
    await sleepUntil(options.pollIntervalMs, options.signal);
  }
}
