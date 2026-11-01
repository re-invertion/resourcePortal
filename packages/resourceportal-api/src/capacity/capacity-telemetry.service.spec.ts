import { describe, expect, it, vi } from "vitest";
import { CapacityPolicyService } from "./capacity-policy.service";
import {
  CapacityTelemetryReconcilerService,
  CapacityTelemetryService,
} from "./capacity-telemetry.service";
import type { MemoryObservation } from "./capacity-hybrid.logic";

const GiB = 1024n * 1024n * 1024n;
const nodeA = "ku2gbq2sm1b2khra543dtyxfg";
const nodeB = "pu2gbq2sm1b2khra543dtyxfh";
const nodeC = "ru2gbq2sm1b2khra543dtyxfj";

class MemoryStore {
  points: MemoryObservation[] = [];

  append(points: MemoryObservation[]) {
    this.points.push(...points);
    return Promise.resolve();
  }

  latestNodes() {
    const latest = new Map<string, MemoryObservation>();
    for (const point of this.points) {
      if (point.appId !== undefined) continue;
      latest.set(point.nodeId, point);
    }
    return Promise.resolve([...latest.values()]);
  }

  appHistory(appId: string, sinceMs: number) {
    return Promise.resolve(
      this.points.filter(
        (point) =>
          point.appId === appId && Date.parse(point.observedAt) >= sinceMs,
      ),
    );
  }

  nodeHistory(nodeId: string, sinceMs: number) {
    return Promise.resolve(
      this.points.filter(
        (point) =>
          point.nodeId === nodeId &&
          point.appId === undefined &&
          Date.parse(point.observedAt) >= sinceMs,
      ),
    );
  }

  observationCount() {
    return Promise.resolve(BigInt(this.points.length));
  }
}

function report(
  swarmNodeId: string,
  availableGiB: number,
  currentGiB: number,
) {
  return {
    status: "Observed" as const,
    swarmNodeId,
    memoryTotalBytes: (32n * GiB).toString(),
    memoryAvailableBytes: (BigInt(availableGiB) * GiB).toString(),
    memoryPsiSomeAvg10: 0,
    memoryPsiFullAvg10: 0,
    containers:
      currentGiB > 0
        ? [
            {
              id: Buffer.from(swarmNodeId, "utf8")
                .toString("hex")
                .slice(0, 12)
                .padEnd(12, "a"),
              appId: "existing-app",
              startedAt: new Date(Date.now() - 86_400_000).toISOString(),
              memoryCurrentBytes: (BigInt(currentGiB) * GiB).toString(),
              memoryPeakBytes: (BigInt(currentGiB) * GiB).toString(),
              oomEvents: "0",
            },
          ]
        : [],
  };
}

function snapshot(
  memoryGiB = 2,
  appId = "new-app",
  desiredReplicas = 1,
) {
  return {
    appGroup: {
      id: "group-new",
      tenantId: "tenant-new",
      runtimeState: "Running",
    },
    singleApps: [
      {
        id: appId,
        runtimeState: "Running",
        desiredReplicas,
        resources: {
          cpu: "1",
          memoryBytes: (BigInt(memoryGiB) * GiB).toString(),
        },
        volumes: [],
      },
    ],
  };
}

function appEvidence(
  appId = "existing-app",
  replicas = 1,
  hardGiB = 2,
  predictedGiB = 1,
) {
  return {
    appId,
    replicas,
    hardLimitBytes: (BigInt(hardGiB) * GiB).toString(),
    predictedBytes: (BigInt(predictedGiB) * GiB).toString(),
    confidence: 1,
    recentOomEvents: "0",
  };
}

function publishedEvidence(
  reports: ReturnType<typeof report>[],
  apps: ReturnType<typeof appEvidence>[] = [],
  ageMs = 0,
) {
  const observedAt = new Date(Date.now() - ageMs).toISOString();
  return {
    generatedAt: observedAt,
    nodes: reports.map((item) => ({
      nodeId: item.swarmNodeId,
      observedAt,
      memoryCurrentBytes: item.containers
        .reduce(
          (sum, container) => sum + BigInt(container.memoryCurrentBytes),
          0n,
        )
        .toString(),
      memoryAvailableBytes: item.memoryAvailableBytes,
      memoryTotalBytes: item.memoryTotalBytes,
      memoryPsiSomeAvg10: item.memoryPsiSomeAvg10,
      memoryPsiFullAvg10: item.memoryPsiFullAvg10,
      p99Bytes: item.containers
        .reduce(
          (sum, container) => sum + BigInt(container.memoryCurrentBytes),
          0n,
        )
        .toString(),
      sampleCount: 100_000,
    })),
    apps,
  };
}

function admissionService(
  reports: ReturnType<typeof report>[],
  apps: ReturnType<typeof appEvidence>[] = [],
  ageMs = 0,
) {
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  };
  const policy = new CapacityPolicyService(config as never);
  const localStore = {
    latestNodes: vi.fn(() =>
      Promise.reject(new Error("API must not read worker JSONL")),
    ),
    appHistory: vi.fn(() =>
      Promise.reject(new Error("API must not read worker JSONL")),
    ),
    nodeHistory: vi.fn(() =>
      Promise.reject(new Error("API must not read worker JSONL")),
    ),
    append: vi.fn(() =>
      Promise.reject(new Error("API must not write worker JSONL")),
    ),
  };
  const lastResult = {
    admissionEvidence: publishedEvidence(reports, apps, ageMs),
  };
  const prisma = {
    workerReconciliationState: {
      findFirst: vi.fn((query: { where?: { key?: string } }) =>
        Promise.resolve(
          query.where?.key === "capacityTelemetry"
            ? {
                lastResult,
                lastSuccessAt: new Date(Date.now() - ageMs),
              }
            : null,
        ),
      ),
    },
  };
  const nodeProbe = {
    collect: vi.fn(() =>
      Promise.reject(new Error("API must not probe Swarm nodes directly")),
    ),
  };
  return {
    telemetry: new CapacityTelemetryService(
      localStore as never,
      policy,
      prisma as never,
      nodeProbe as never,
    ),
    localStore,
    nodeProbe,
  };
}

describe("Hybrid admission from worker-published telemetry", () => {
  it("admits without reading or writing the worker JSONL from the API path", async () => {
    const { telemetry, localStore, nodeProbe } = admissionService([
      report(nodeA, 20, 5),
      report(nodeB, 18, 6),
    ]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA, nodeB],
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.decision.allowed).toBe(true);
    expect(localStore.latestNodes).not.toHaveBeenCalled();
    expect(localStore.append).not.toHaveBeenCalled();
    expect(nodeProbe.collect).not.toHaveBeenCalled();
  });

  it("falls back instead of guessing when one schedulable node has no fresh report", async () => {
    const { telemetry } = admissionService([report(nodeA, 20, 5)]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA, nodeB],
    });
    expect(result).toMatchObject({ usable: false });
    if (result.usable) return;
    expect(result.reason).toContain("does not cover every schedulable");
  });

  it("does not let an unschedulable reporting node substitute for a missing schedulable node", async () => {
    const { telemetry } = admissionService([
      report(nodeA, 20, 5),
      report(nodeB, 18, 6),
    ]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA, nodeC],
    });
    expect(result).toMatchObject({ usable: false });
    if (result.usable) return;
    expect(result.reason).toContain("does not cover every schedulable");
  });

  it("falls back when the worker-published snapshot is stale", async () => {
    const { telemetry } = admissionService(
      [report(nodeA, 20, 5)],
      [],
      120_000,
    );
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA],
    });
    expect(result).toEqual({
      usable: false,
      reason: "fresh worker-published Hybrid admission telemetry is unavailable",
    });
  });

  it("rejects when any schedulable node would cross its own safety reserve", async () => {
    const { telemetry } = admissionService([
      report(nodeA, 20, 5),
      report(nodeB, 5, 25),
    ]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA, nodeB],
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toContain(nodeB);
  });

  it("scales historical predicted demand when replica count increases", async () => {
    const { telemetry } = admissionService(
      [report(nodeA, 16, 1)],
      [appEvidence("existing-app", 1, 2, 1)],
    );
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot(2, "existing-app", 10) as never,
      runningApps: [
        {
          appId: "existing-app",
          hardLimitBytes: 2n * GiB,
          replicas: 1,
        },
      ],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA],
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.requestedPredictedBytes).toBe(9n * GiB);
    expect(result.decision.allowed).toBe(true);
  });

  it("does not correlation-discount replica growth that telemetry has not observed yet", async () => {
    const { telemetry } = admissionService(
      [report(nodeA, 16, 1)],
      [appEvidence("existing-app", 1, 12, 1)],
    );
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot(1, "new-app", 1) as never,
      runningApps: [
        {
          appId: "existing-app",
          hardLimitBytes: 12n * GiB,
          replicas: 6,
        },
      ],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA],
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.decision.predictedExistingGrowthBytes).toBe(5n * GiB);
  });

  it("does not reserve hard-limit growth twice when replica count is unchanged", async () => {
    const { telemetry } = admissionService(
      [report(nodeA, 16, 1)],
      [appEvidence("existing-app", 1, 2, 1)],
    );
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot(4, "existing-app", 1) as never,
      runningApps: [
        {
          appId: "existing-app",
          hardLimitBytes: 2n * GiB,
          replicas: 1,
        },
      ],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA],
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.requestedPredictedBytes).toBe(0n);
    expect(result.decision.allowed).toBe(true);
  });
});

describe("worker collection completeness", () => {
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === "WORKER_ID" ? "worker-1" : fallback,
  };

  it("does not append partial app telemetry when a schedulable node is missing", async () => {
    const store = new MemoryStore();
    const policy = new CapacityPolicyService(config as never);
    const prisma = {
      singleApp: {
        findMany: vi.fn(() =>
          Promise.resolve([{ id: "existing-app", actualReplicas: 1 }]),
        ),
      },
      remoteLocation: {
        findMany: vi.fn(() =>
          Promise.resolve([
            { swarmNodeId: nodeA },
            { swarmNodeId: nodeB },
          ]),
        ),
      },
      workerReconciliationState: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    };
    const nodeProbe = {
      collect: vi.fn(() => Promise.resolve([report(nodeA, 20, 5)])),
    };
    const telemetry = new CapacityTelemetryService(
      store as never,
      policy,
      prisma as never,
      nodeProbe as never,
    );

    await expect(telemetry.observeNow()).rejects.toThrow(
      /does not cover every schedulable node/,
    );
    expect(store.points).toEqual([]);
  });

  it("includes replicas on a paused node in application aggregation while excluding it from headroom", async () => {
    const store = new MemoryStore();
    const policy = new CapacityPolicyService(config as never);
    const prisma = {
      singleApp: {
        findMany: vi.fn(() =>
          Promise.resolve([{ id: "existing-app", actualReplicas: 2 }]),
        ),
      },
      remoteLocation: {
        findMany: vi.fn(() => Promise.resolve([{ swarmNodeId: nodeA }])),
      },
      workerReconciliationState: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    };
    const nodeProbe = {
      collect: vi.fn(() =>
        Promise.resolve([
          report(nodeA, 20, 1),
          report(nodeB, 18, 1),
        ]),
      ),
    };
    const telemetry = new CapacityTelemetryService(
      store as never,
      policy,
      prisma as never,
      nodeProbe as never,
    );

    const points = await telemetry.observeNow();
    const appPoint = points.find((point) => point.appId === "existing-app");
    expect(appPoint?.memoryCurrentBytes).toBe(2n * GiB);
    expect(appPoint?.containerId.split(",")).toHaveLength(2);
    expect(points.filter((point) => point.appId === undefined)).toHaveLength(1);
    expect(
      points.find(
        (point) => point.appId === undefined && point.nodeId === nodeB,
      ),
    ).toBeUndefined();
  });

  it("fails closed when observed application containers do not cover actualReplicas", async () => {
    const store = new MemoryStore();
    const policy = new CapacityPolicyService(config as never);
    const prisma = {
      singleApp: {
        findMany: vi.fn(() =>
          Promise.resolve([{ id: "existing-app", actualReplicas: 2 }]),
        ),
      },
      remoteLocation: {
        findMany: vi.fn(() => Promise.resolve([{ swarmNodeId: nodeA }])),
      },
      workerReconciliationState: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    };
    const nodeProbe = {
      collect: vi.fn(() => Promise.resolve([report(nodeA, 20, 1)])),
    };
    const telemetry = new CapacityTelemetryService(
      store as never,
      policy,
      prisma as never,
      nodeProbe as never,
    );

    await expect(telemetry.observeNow()).rejects.toThrow(
      /does not match observed runtime replicas/,
    );
    expect(store.points).toEqual([]);
  });

  it("invalidates fresh published evidence immediately when a whole node probe is missing", async () => {
    const store = new MemoryStore();
    const policy = new CapacityPolicyService(config as never);
    let lastResult: Record<string, unknown> = {
      admissionEvidence: publishedEvidence(
        [report(nodeA, 20, 5), report(nodeB, 18, 6)],
        [appEvidence("existing-app", 2, 4, 2)],
      ),
    };
    const lastSuccessAt = new Date();
    const updateMany = vi.fn((query: { data?: { lastResult?: unknown } }) => {
      if (query.data?.lastResult && typeof query.data.lastResult === "object") {
        lastResult = query.data.lastResult as Record<string, unknown>;
      }
      return Promise.resolve({ count: 1 });
    });
    const prisma = {
      singleApp: {
        findMany: vi.fn(() =>
          Promise.resolve([{ id: "existing-app", actualReplicas: 1 }]),
        ),
      },
      remoteLocation: {
        findMany: vi.fn(() =>
          Promise.resolve([
            { swarmNodeId: nodeA },
            { swarmNodeId: nodeB },
          ]),
        ),
      },
      workerReconciliationState: {
        findFirst: vi.fn((query: { where?: { key?: string } }) =>
          Promise.resolve(
            query.where?.key === "capacityTelemetry"
              ? { lastResult, lastSuccessAt }
              : null,
          ),
        ),
        updateMany,
      },
    };
    const nodeProbe = {
      collect: vi.fn(() => Promise.resolve([report(nodeA, 20, 5)])),
    };
    const telemetry = new CapacityTelemetryService(
      store as never,
      policy,
      prisma as never,
      nodeProbe as never,
    );
    const reconciler = new CapacityTelemetryReconcilerService(
      telemetry,
      config as never,
    );

    await reconciler.collect(true);

    expect(updateMany).toHaveBeenCalledOnce();
    expect(lastResult).toMatchObject({
      unavailable: true,
      admissionEvidence: null,
    });

    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [
        {
          appId: "existing-app",
          hardLimitBytes: 4n * GiB,
          replicas: 2,
        },
      ],
      inFlightSnapshots: [],
      schedulableNodeIds: [nodeA, nodeB],
    });
    expect(result).toEqual({
      usable: false,
      reason: "fresh worker-published Hybrid admission telemetry is unavailable",
    });
  });
});

describe("capacity policy validation", () => {
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  };

  it("rejects fractional application and node percentage settings before persistence", () => {
    const policy = new CapacityPolicyService(config as never);
    expect(() =>
      policy.set({ applicationMarginPercent: 15.5 }),
    ).toThrow(/application margin must be an integer/);
    expect(() =>
      policy.set({ nodeSafetyBufferPercent: 20.5 }),
    ).toThrow(/node safety buffer must be an integer/);
  });
});

describe("worker admission evidence publication", () => {
  it("publishes JSON-safe per-node and per-app evidence for API admission", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    store.points.push(
      {
        observedAt: now,
        nodeId: nodeA,
        appId: "existing-app",
        containerId: "aaaaaaaaaaaa",
        containerStartedAt: new Date(Date.now() - 60_000).toISOString(),
        memoryCurrentBytes: 1n * GiB,
        memoryPeakBytes: 1n * GiB,
        oomEvents: 0n,
        nodeMemoryAvailableBytes: 20n * GiB,
        nodeMemoryTotalBytes: 32n * GiB,
        bucketSeconds: 30,
      },
      {
        observedAt: now,
        nodeId: nodeA,
        memoryCurrentBytes: 1n * GiB,
        memoryPeakBytes: 1n * GiB,
        startupPeakBytes: 3n * GiB,
        oomEvents: 0n,
        nodeMemoryAvailableBytes: 20n * GiB,
        nodeMemoryTotalBytes: 32n * GiB,
        bucketSeconds: 30,
      },
    );
    const config = {
      get: (_key: string, fallback?: unknown) => fallback,
    };
    const policy = new CapacityPolicyService(config as never);
    const upsert = vi.fn(() => Promise.resolve({}));
    const prisma = {
      singleApp: {
        findMany: () =>
          Promise.resolve([
            {
              id: "existing-app",
              name: "Existing",
              memoryBytes: 2n * GiB,
              actualReplicas: 1,
              desiredReplicas: 1,
            },
          ]),
      },
      appGroupDeployment: {
        findMany: () => Promise.resolve([]),
      },
      workerReconciliationState: {
        upsert,
        updateMany: () => Promise.resolve({ count: 0 }),
      },
    };
    const telemetry = new CapacityTelemetryService(
      store as never,
      policy,
      prisma as never,
      { collect: vi.fn() } as never,
    );
    const diagnostics = await telemetry.publishDiagnostics("worker-1");
    expect(diagnostics.nodes).toEqual([
      expect.objectContaining({
        nodeId: nodeA,
        startupPeakBytes: (3n * GiB).toString(),
      }),
    ]);
    expect(diagnostics.admissionEvidence).toMatchObject({
      nodes: [
        {
          nodeId: nodeA,
          memoryAvailableBytes: (20n * GiB).toString(),
          memoryTotalBytes: (32n * GiB).toString(),
        },
      ],
      apps: [
        {
          appId: "existing-app",
          replicas: 1,
          hardLimitBytes: (2n * GiB).toString(),
        },
      ],
    });
    expect(upsert).toHaveBeenCalledOnce();
  });
});
