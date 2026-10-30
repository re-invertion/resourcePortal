import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  type MemoryObservation,
} from "./capacity-hybrid.logic";
import { CapacityTelemetryStore } from "./capacity-telemetry.store";

const GiB = 1024n * 1024n * 1024n;
let directory: string | undefined;

function observation(
  observedAt: string,
  overrides: Partial<MemoryObservation> = {},
): MemoryObservation {
  return {
    observedAt,
    nodeId: "node-a",
    appId: "app-a",
    containerId: "container-a",
    containerStartedAt: new Date(
      Date.parse(observedAt) - 60_000,
    ).toISOString(),
    memoryCurrentBytes: 2n * GiB,
    memoryPeakBytes: 3n * GiB,
    oomEvents: 0n,
    nodeMemoryAvailableBytes: 40n * GiB,
    nodeMemoryTotalBytes: 64n * GiB,
    bucketSeconds: 30,
    ...overrides,
  };
}

async function store() {
  directory = await mkdtemp(join(tmpdir(), "rp-capacity-"));
  const path = join(directory, "capacity.sqlite");
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === "CAPACITY_TELEMETRY_PATH" ? path : fallback,
  };
  return new CapacityTelemetryStore(config as never);
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("CapacityTelemetryStore", () => {
  it("persists exact application and per-node observations across store instances", async () => {
    const instance = await store();
    const now = new Date().toISOString();
    await instance.append(
      [
        observation(now),
        observation(now, {
          appId: undefined,
          containerId: undefined,
          containerStartedAt: undefined,
          memoryCurrentBytes: 8n * GiB,
          memoryPeakBytes: 8n * GiB,
        }),
      ],
      DEFAULT_CAPACITY_POLICY,
    );

    const app = await instance.appHistory("app-a", Date.now() - 60_000);
    const nodes = await instance.latestNodes();
    expect(app).toHaveLength(1);
    expect(app[0].memoryCurrentBytes).toBe(2n * GiB);
    expect(app[0].startupPeakBytes).toBe(3n * GiB);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeMemoryAvailableBytes).toBe(40n * GiB);
    expect(await instance.observationCount()).toBe(2n);
  });

  it("downsamples old exact history while retaining peaks and startup evidence", async () => {
    const instance = await store();
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 86_400_000);
    const thirtyOneDaysAgo = new Date(now - 31 * 86_400_000);

    await instance.append(
      [
        observation(eightDaysAgo.toISOString(), {
          memoryCurrentBytes: 1n * GiB,
          memoryPeakBytes: 5n * GiB,
        }),
        observation(new Date(eightDaysAgo.getTime() + 30_000).toISOString(), {
          memoryCurrentBytes: 3n * GiB,
          memoryPeakBytes: 6n * GiB,
        }),
        observation(thirtyOneDaysAgo.toISOString(), {
          memoryCurrentBytes: 2n * GiB,
          memoryPeakBytes: 7n * GiB,
        }),
      ],
      DEFAULT_CAPACITY_POLICY,
    );

    const history = await instance.appHistory(
      "app-a",
      now - 90 * 86_400_000,
    );
    expect(history.some((item) => item.bucketSeconds === 300)).toBe(true);
    expect(history.some((item) => item.bucketSeconds === 3600)).toBe(true);
    expect(
      history.some(
        (item) =>
          item.bucketSeconds === 300 && item.memoryPeakBytes === 6n * GiB,
      ),
    ).toBe(true);
    expect(
      history.some(
        (item) =>
          item.bucketSeconds === 3600 && item.memoryPeakBytes === 7n * GiB,
      ),
    ).toBe(true);
    expect(
      history.some((item) => (item.startupPeakBytes ?? 0n) >= 5n * GiB),
    ).toBe(true);
  });
});