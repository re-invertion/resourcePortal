import { describe, expect, it } from "vitest";
import { CapacityPolicyService } from "./capacity-policy.service";
import { CapacityTelemetryService } from "./capacity-telemetry.service";
import type { MemoryObservation } from "./capacity-hybrid.logic";

const GiB = 1024n * 1024n * 1024n;
const nodeA = "ku2gbq2sm1b2khra543dtyxfg";
const nodeB = "pu2gbq2sm1b2khra543dtyxfh";

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
    return Promise.resolve(this.points.filter(
      (point) =>
        point.appId === appId && Date.parse(point.observedAt) >= sinceMs,
    ));
  }

  nodeHistory(nodeId: string, sinceMs: number) {
    return Promise.resolve(this.points.filter(
      (point) =>
        point.nodeId === nodeId &&
        point.appId === undefined &&
        Date.parse(point.observedAt) >= sinceMs,
    ));
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
              id: swarmNodeId.slice(0, 12).replace(/[^a-f0-9]/g, "a").padEnd(12, "a"),
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

function snapshot(memoryGiB = 2) {
  return {
    appGroup: {
      id: "group-new",
      runtimeState: "Running",
    },
    singleApps: [
      {
        id: "new-app",
        runtimeState: "Running",
        desiredReplicas: 1,
        resources: {
          cpu: "1",
          memoryBytes: (BigInt(memoryGiB) * GiB).toString(),
        },
        volumes: [],
      },
    ],
  };
}

function service(reports: ReturnType<typeof report>[]) {
  const store = new MemoryStore();
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  };
  const policy = new CapacityPolicyService(config as never);
  const prisma = {
    workerReconciliationState: {
      findFirst: () => Promise.resolve(null),
    },
  };
  const nodeProbe = {
    collect: () => Promise.resolve(reports),
  };
  return new CapacityTelemetryService(
    store as never,
    policy,
    prisma as never,
    nodeProbe as never,
  );
}

describe("Hybrid multi-node admission", () => {
  it("admits only when every schedulable node preserves its physical reserve", async () => {
    const telemetry = service([
      report(nodeA, 20, 5),
      report(nodeB, 18, 6),
    ]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeCount: 2n,
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.decision.allowed).toBe(true);
  });

  it("falls back instead of guessing when one schedulable node has no fresh report", async () => {
    const telemetry = service([report(nodeA, 20, 5)]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeCount: 2n,
    });
    expect(result).toMatchObject({
      usable: false,
    });
    if (result.usable) return;
    expect(result.reason).toContain("does not cover every schedulable");
  });

  it("rejects when any schedulable node would cross its own safety reserve", async () => {
    const telemetry = service([
      report(nodeA, 20, 5),
      report(nodeB, 5, 25),
    ]);
    const result = await telemetry.evaluateAdmission({
      snapshot: snapshot() as never,
      runningApps: [],
      inFlightSnapshots: [],
      schedulableNodeCount: 2n,
    });
    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toContain(nodeB);
  });
});
