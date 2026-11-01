import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  compactMemoryObservations,
  correlatedExistingDemand,
  evaluateHybridNodeAdmission,
  percentile,
  predictAppMemory,
  type MemoryObservation,
} from "./capacity-hybrid.logic";

const GiB = 1024n * 1024n * 1024n;
const MiB = 1024n * 1024n;
const now = Date.parse("2026-10-29T20:00:00.000Z");

function point(
  ageMs: number,
  overrides: Partial<MemoryObservation> = {},
): MemoryObservation {
  return {
    observedAt: new Date(now - ageMs).toISOString(),
    nodeId: "node-1",
    appId: "app-1",
    containerId: "container-1",
    containerStartedAt: new Date(now - ageMs - 60_000).toISOString(),
    memoryCurrentBytes: 1n * GiB,
    memoryPeakBytes: 1n * GiB,
    oomEvents: 0n,
    nodeMemoryAvailableBytes: 45n * GiB,
    nodeMemoryTotalBytes: 63n * GiB,
    bucketSeconds: 30,
    ...overrides,
  };
}

describe("Hybrid capacity prediction", () => {
  it("calculates deterministic nearest-rank percentiles", () => {
    expect(percentile([1n, 2n, 3n, 4n, 100n], 0.95)).toBe(100n);
    expect(percentile([5n, 1n, 3n, 2n, 4n], 0.5)).toBe(3n);
    expect(percentile([], 0.99)).toBe(0n);
  });

  it("keeps 7d exact samples, 30d five-minute maxima and 90d hourly maxima", () => {
    const observations = [
      point(1 * 86_400_000, { memoryCurrentBytes: 500n * MiB }),
      point(8 * 86_400_000, { memoryCurrentBytes: 1n * GiB, memoryPeakBytes: 2n * GiB }),
      point(8 * 86_400_000 + 60_000, { memoryCurrentBytes: 3n * GiB, memoryPeakBytes: 4n * GiB }),
      point(31 * 86_400_000, { memoryCurrentBytes: 2n * GiB, memoryPeakBytes: 5n * GiB }),
      point(31 * 86_400_000 + 60_000, { memoryCurrentBytes: 4n * GiB, memoryPeakBytes: 6n * GiB }),
      point(91 * 86_400_000),
    ];
    const compacted = compactMemoryObservations(observations, now);
    expect(compacted.some((p) => p.bucketSeconds === 30)).toBe(true);
    expect(compacted.some((p) => p.bucketSeconds === 300 && p.memoryPeakBytes === 4n * GiB)).toBe(true);
    expect(compacted.some((p) => p.bucketSeconds === 3600 && p.memoryPeakBytes === 6n * GiB)).toBe(true);
    expect(compacted.every((p) => Date.parse(p.observedAt) >= now - 90 * 86_400_000)).toBe(true);
  });

  it("uses fresh real usage with low confidence on day one instead of equating the hard limit with physical use", () => {
    const prediction = predictAppMemory(
      "app-1",
      [point(30_000, { memoryCurrentBytes: 2n * GiB, memoryPeakBytes: 2n * GiB })],
      8n * GiB,
      DEFAULT_CAPACITY_POLICY,
      now,
    );
    expect(prediction.predictedBytes).toBeLessThan(3n * GiB);
    expect(prediction.predictedBytes).toBeGreaterThan(2n * GiB);
    expect(prediction.confidence).toBeLessThan(0.2);
  });

  it("falls back conservatively to the hard limit when a new app has no history", () => {
    const prediction = predictAppMemory(
      "new-app",
      [],
      1250n * MiB,
      DEFAULT_CAPACITY_POLICY,
      now,
    );
    expect(prediction.predictedBytes).toBe(1250n * MiB);
    expect(prediction.confidence).toBe(0.05);
  });

  it("does not interpret old cgroup peaks as current usage after a container restart", () => {
    const prediction = predictAppMemory(
      "app-1",
      [
        point(2 * 86_400_000, {
          containerId: "old",
          memoryCurrentBytes: 1n * GiB,
          memoryPeakBytes: 7n * GiB,
        }),
        point(10_000, {
          containerId: "new",
          containerStartedAt: new Date(now - 20_000).toISOString(),
          memoryCurrentBytes: 2n * GiB,
          memoryPeakBytes: 2n * GiB,
        }),
      ],
      8n * GiB,
      DEFAULT_CAPACITY_POLICY,
      now,
    );
    expect(prediction.currentBytes).toBe(2n * GiB);
    expect(prediction.max7dBytes).toBe(7n * GiB);
    expect(prediction.startupPeakBytes).toBe(7n * GiB);
  });

  it("uses same-time node correlation when history is mature, but remains conservative when coverage is weak", () => {
    const mature = correlatedExistingDemand({
      sumAppPredictedBytes: 24n * GiB,
      nodeP99Bytes: 12n * GiB,
      currentAppMemoryBytes: 10n * GiB,
      minAppConfidence: 1,
      nodeSampleCount: 30 * 24 * 60 * 2,
    });
    const immature = correlatedExistingDemand({
      sumAppPredictedBytes: 24n * GiB,
      nodeP99Bytes: 12n * GiB,
      currentAppMemoryBytes: 10n * GiB,
      minAppConfidence: 0.1,
      nodeSampleCount: 10,
    });
    expect(mature).toBeLessThan(16n * GiB);
    expect(immature).toBeGreaterThan(22n * GiB);
  });

  it("allows the #373-like 62.8 GiB host to overcommit hard limits when physical and predicted headroom remain safe", () => {
    const decision = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 67417341952n,
      nodeMemoryAvailableBytes: 46n * GiB,
      currentAppMemoryBytes: 17n * GiB,
      predictedExistingBytes: 20n * GiB,
      requestedPredictedBytes: 2n * GiB,
      inFlightPredictedBytes: 0n,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.remainingAfterAdmissionBytes).toBeGreaterThan(decision.safetyReserveBytes);
  });

  it("blocks the same host under real pressure even when declared hard limits could fit", () => {
    const decision = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 67417341952n,
      nodeMemoryAvailableBytes: 8n * GiB,
      currentAppMemoryBytes: 55n * GiB,
      predictedExistingBytes: 58n * GiB,
      requestedPredictedBytes: 2n * GiB,
      inFlightPredictedBytes: 0n,
      memoryPsiSomeAvg10: 12,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("memory pressure");
  });

  it("accounts for parallel in-flight reservations so two deployments cannot consume the same headroom", () => {
    const withoutParallel = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 32n * GiB,
      nodeMemoryAvailableBytes: 12n * GiB,
      currentAppMemoryBytes: 18n * GiB,
      predictedExistingBytes: 19n * GiB,
      requestedPredictedBytes: 2n * GiB,
      inFlightPredictedBytes: 0n,
    });
    const withParallel = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 32n * GiB,
      nodeMemoryAvailableBytes: 12n * GiB,
      currentAppMemoryBytes: 18n * GiB,
      predictedExistingBytes: 19n * GiB,
      requestedPredictedBytes: 2n * GiB,
      inFlightPredictedBytes: 4n * GiB,
    });
    expect(withoutParallel.allowed).toBe(true);
    expect(withParallel.allowed).toBe(false);
  });

  it("tightens admission after OOM events", () => {
    const decision = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 32n * GiB,
      nodeMemoryAvailableBytes: 14n * GiB,
      currentAppMemoryBytes: 17n * GiB,
      predictedExistingBytes: 18n * GiB,
      requestedPredictedBytes: 1n * GiB,
      inFlightPredictedBytes: 0n,
      recentOomEvents: 1n,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("OOM");
  });

  it.each([3250, 3500, 4096])(
    "admits Ollama memory limit growth to %d MiB with sufficient physical headroom",
    (targetMiB) => {
      const decision = evaluateHybridNodeAdmission({
        nodeMemoryTotalBytes: 67417341952n,
        nodeMemoryAvailableBytes: 46n * GiB,
        currentAppMemoryBytes: 17n * GiB,
        predictedExistingBytes: 20n * GiB,
        requestedPredictedBytes: BigInt(targetMiB - 3072) * MiB,
        inFlightPredictedBytes: 0n,
      });
      expect(decision.allowed).toBe(true);
    },
  );

  it("admits a 1.25 GiB speech service from zero replicas with sufficient headroom", () => {
    const decision = evaluateHybridNodeAdmission({
      nodeMemoryTotalBytes: 67417341952n,
      nodeMemoryAvailableBytes: 46n * GiB,
      currentAppMemoryBytes: 17n * GiB,
      predictedExistingBytes: 20n * GiB,
      requestedPredictedBytes: 1280n * MiB,
      inFlightPredictedBytes: 0n,
    });
    expect(decision.allowed).toBe(true);
  });
});
