export type CapacityMode = "Strict" | "Hybrid";

export type CapacityPolicy = {
  mode: CapacityMode;
  telemetryIntervalSeconds: number;
  exactRetentionDays: number;
  predictionWindowDays: number;
  rareEventRetentionDays: number;
  predictionPercentile: 95 | 99;
  applicationMarginPercent: number;
  nodeSafetyBufferPercent: number;
  minimumSystemReserveBytes: bigint;
  maxTelemetryAgeSeconds: number;
};

export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = {
  mode: "Hybrid",
  telemetryIntervalSeconds: 30,
  exactRetentionDays: 7,
  predictionWindowDays: 30,
  rareEventRetentionDays: 90,
  predictionPercentile: 99,
  applicationMarginPercent: 15,
  nodeSafetyBufferPercent: 20,
  minimumSystemReserveBytes: 1_073_741_824n,
  maxTelemetryAgeSeconds: 90,
};

export type MemoryObservation = {
  observedAt: string;
  nodeId: string;
  appId?: string;
  containerId?: string;
  containerStartedAt?: string;
  memoryCurrentBytes: bigint;
  memoryPeakBytes: bigint;
  startupPeakBytes?: bigint;
  oomEvents: bigint;
  memoryPsiSomeAvg10?: number;
  memoryPsiFullAvg10?: number;
  nodeMemoryAvailableBytes?: bigint;
  nodeMemoryTotalBytes?: bigint;
  bucketSeconds: 30 | 300 | 3600;
};

export type AppMemoryPrediction = {
  appId: string;
  currentBytes: bigint;
  averageBytes: bigint;
  p95Bytes: bigint;
  p99Bytes: bigint;
  max7dBytes: bigint;
  max30dBytes: bigint;
  max90dBytes: bigint;
  startupPeakBytes: bigint;
  predictedBytes: bigint;
  confidence: number;
  sampleCount: number;
  recentOomEvents: bigint;
};

const DAY_MS = 86_400_000;

export function percentile(values: bigint[], q: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

export function average(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

export function maxBigInt(values: bigint[]): bigint {
  return values.reduce((max, value) => value > max ? value : max, 0n);
}

export function compactMemoryObservations(
  observations: MemoryObservation[],
  now = Date.now(),
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
): MemoryObservation[] {
  const exactBoundary = now - policy.exactRetentionDays * DAY_MS;
  const fiveMinuteBoundary = now - policy.predictionWindowDays * DAY_MS;
  const hourlyBoundary = now - policy.rareEventRetentionDays * DAY_MS;
  const kept: MemoryObservation[] = [];
  const fiveMinute = new Map<string, MemoryObservation[]>();
  const hourly = new Map<string, MemoryObservation[]>();

  for (const point of observations) {
    const ts = Date.parse(point.observedAt);
    if (!Number.isFinite(ts) || ts < hourlyBoundary) continue;
    if (ts >= exactBoundary) {
      kept.push({ ...point, bucketSeconds: 30 });
      continue;
    }
    const target = ts >= fiveMinuteBoundary ? fiveMinute : hourly;
    const bucketMs = ts >= fiveMinuteBoundary ? 300_000 : 3_600_000;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const key = [point.nodeId, point.appId ?? "node", bucket, bucketMs].join(":");
    const list = target.get(key) ?? [];
    list.push(point);
    target.set(key, list);
  }

  for (const [key, group] of [...fiveMinute, ...hourly]) {
    const bucketMs = Number(key.split(":").at(-1));
    const newest = [...group].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    const peak = maxBigInt(group.map((item) => item.memoryPeakBytes));
    const currentMax = maxBigInt(group.map((item) => item.memoryCurrentBytes));
    const oomMax = maxBigInt(group.map((item) => item.oomEvents));
    const startupPeakMax = maxBigInt(
      group.map((item) => item.startupPeakBytes ?? 0n),
    );
    const availableMin = group
      .map((item) => item.nodeMemoryAvailableBytes)
      .filter((value): value is bigint => value !== undefined)
      .reduce<bigint | undefined>((min, value) => min === undefined || value < min ? value : min, undefined);
    kept.push({
      ...newest,
      observedAt: new Date(Math.floor(Date.parse(newest.observedAt) / bucketMs) * bucketMs).toISOString(),
      memoryCurrentBytes: currentMax,
      memoryPeakBytes: peak,
      oomEvents: oomMax,
      startupPeakBytes: startupPeakMax,
      nodeMemoryAvailableBytes: availableMin,
      memoryPsiSomeAvg10: Math.max(...group.map((item) => item.memoryPsiSomeAvg10 ?? 0)),
      memoryPsiFullAvg10: Math.max(...group.map((item) => item.memoryPsiFullAvg10 ?? 0)),
      bucketSeconds: bucketMs === 300_000 ? 300 : 3600,
    });
  }

  return kept.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

export function predictAppMemory(
  appId: string,
  observations: MemoryObservation[],
  hardLimitBytes: bigint,
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
  now = Date.now(),
): AppMemoryPrediction {
  const app = observations.filter((item) => item.appId === appId);
  const inDays = (days: number) => app.filter((item) => Date.parse(item.observedAt) >= now - days * DAY_MS);
  const seven = inDays(7);
  const thirty = inDays(policy.predictionWindowDays);
  const ninety = inDays(policy.rareEventRetentionDays);
  const primary = thirty.length > 0 ? thirty : ninety;
  const values = primary.map((item) => item.memoryCurrentBytes);
  const latest = [...app].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  const startup = ninety.filter((item) => {
    if (!item.containerStartedAt) return false;
    const age = Date.parse(item.observedAt) - Date.parse(item.containerStartedAt);
    return Number.isFinite(age) && age >= 0 && age <= 10 * 60_000;
  });
  const latestByContainer = new Map<string, MemoryObservation>();
  for (const item of ninety) {
    const key = item.containerId ?? ((item.appId ?? "unknown") + ":" + item.observedAt);
    const existing = latestByContainer.get(key);
    if (!existing || Date.parse(item.observedAt) > Date.parse(existing.observedAt)) {
      latestByContainer.set(key, item);
    }
  }
  let recentOomEvents = 0n;
  for (const item of latestByContainer.values()) recentOomEvents += item.oomEvents;

  const p95Bytes = percentile(values, 0.95);
  const p99Bytes = percentile(values, 0.99);
  const startupPeakBytes = maxBigInt([
    ...startup.map((item) => item.memoryPeakBytes),
    ...ninety.map((item) => item.startupPeakBytes ?? 0n),
  ]);
  const observedBase = maxBigInt([
    policy.predictionPercentile === 99 ? p99Bytes : p95Bytes,
    startupPeakBytes,
    maxBigInt(seven.map((item) => item.memoryCurrentBytes)),
  ]);
  const fallback = hardLimitBytes > 0n ? hardLimitBytes : 512n * 1024n * 1024n;
  const base = observedBase > 0n ? observedBase : fallback;
  const margin = BigInt(100 + policy.applicationMarginPercent);
  const withMargin = (base * margin + 99n) / 100n;
  const predictedBytes = hardLimitBytes > 0n && withMargin > hardLimitBytes ? hardLimitBytes : withMargin;

  const expected30d = Math.max(1, Math.floor(policy.predictionWindowDays * 86_400 / policy.telemetryIntervalSeconds));
  const coverage = Math.min(1, app.length / expected30d);
  const oldest = [...app].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
  const ageDays = oldest
    ? Math.min(policy.predictionWindowDays, Math.max(0, (now - Date.parse(oldest.observedAt)) / DAY_MS))
    : 0;
  const ageCoverage = Math.min(1, ageDays / policy.predictionWindowDays);
  const confidence = Math.max(0.05, Math.min(1, 0.65 * coverage + 0.35 * ageCoverage));

  return {
    appId,
    currentBytes: latest?.memoryCurrentBytes ?? 0n,
    averageBytes: average(values),
    p95Bytes,
    p99Bytes,
    max7dBytes: maxBigInt(seven.map((item) => item.memoryPeakBytes)),
    max30dBytes: maxBigInt(thirty.map((item) => item.memoryPeakBytes)),
    max90dBytes: maxBigInt(ninety.map((item) => item.memoryPeakBytes)),
    startupPeakBytes,
    predictedBytes,
    confidence,
    sampleCount: app.length,
    recentOomEvents,
  };
}

export function correlatedExistingDemand(input: {
  sumAppPredictedBytes: bigint;
  nodeP99Bytes: bigint;
  currentAppMemoryBytes: bigint;
  minAppConfidence: number;
  nodeSampleCount: number;
  policy?: CapacityPolicy;
}): bigint {
  const policy = input.policy ?? DEFAULT_CAPACITY_POLICY;
  const nodeProfileWithMargin =
    input.nodeP99Bytes * BigInt(100 + policy.applicationMarginPercent) / 100n;
  const nodeFloor =
    nodeProfileWithMargin > input.currentAppMemoryBytes
      ? nodeProfileWithMargin
      : input.currentAppMemoryBytes;
  if (input.sumAppPredictedBytes <= nodeFloor) return nodeFloor;
  const expectedNodeSamples = Math.max(
    1,
    Math.floor(
      policy.predictionWindowDays *
        86_400 /
        policy.telemetryIntervalSeconds,
    ),
  );
  const nodeCoverage = Math.min(1, input.nodeSampleCount / expectedNodeSamples);
  const correlationConfidence = Math.min(
    Math.max(0, input.minAppConfidence),
    nodeCoverage,
  );
  const cautiousShare = Math.round((1 - correlationConfidence) * 10_000);
  return (
    nodeFloor +
    (input.sumAppPredictedBytes - nodeFloor) *
      BigInt(cautiousShare) /
      10_000n
  );
}

export type HybridNodeDecision = {
  allowed: boolean;
  reason: string;
  nodeMemoryTotalBytes: bigint;
  nodeMemoryAvailableBytes: bigint;
  safetyReserveBytes: bigint;
  currentAppMemoryBytes: bigint;
  predictedExistingGrowthBytes: bigint;
  requestedPredictedBytes: bigint;
  inFlightPredictedBytes: bigint;
  remainingAfterAdmissionBytes: bigint;
};

export function evaluateHybridNodeAdmission(input: {
  nodeMemoryTotalBytes: bigint;
  nodeMemoryAvailableBytes: bigint;
  currentAppMemoryBytes: bigint;
  predictedExistingBytes: bigint;
  requestedPredictedBytes: bigint;
  inFlightPredictedBytes: bigint;
  memoryPsiSomeAvg10?: number;
  memoryPsiFullAvg10?: number;
  recentOomEvents?: bigint;
  policy?: CapacityPolicy;
}): HybridNodeDecision {
  const policy = input.policy ?? DEFAULT_CAPACITY_POLICY;
  const percentReserve = input.nodeMemoryTotalBytes * BigInt(policy.nodeSafetyBufferPercent) / 100n;
  const safetyReserveBytes = percentReserve > policy.minimumSystemReserveBytes ? percentReserve : policy.minimumSystemReserveBytes;
  const predictedExistingGrowthBytes = input.predictedExistingBytes > input.currentAppMemoryBytes
    ? input.predictedExistingBytes - input.currentAppMemoryBytes
    : 0n;
  const requiredGrowth = predictedExistingGrowthBytes + input.requestedPredictedBytes + input.inFlightPredictedBytes;
  const remainingAfterAdmissionBytes = input.nodeMemoryAvailableBytes > requiredGrowth
    ? input.nodeMemoryAvailableBytes - requiredGrowth
    : 0n;

  const pressureHigh = (input.memoryPsiFullAvg10 ?? 0) >= 1 || (input.memoryPsiSomeAvg10 ?? 0) >= 10;
  if (pressureHigh) {
    return {
      allowed: false,
      reason: "memory pressure is above the Hybrid safety threshold",
      nodeMemoryTotalBytes: input.nodeMemoryTotalBytes,
      nodeMemoryAvailableBytes: input.nodeMemoryAvailableBytes,
      safetyReserveBytes,
      currentAppMemoryBytes: input.currentAppMemoryBytes,
      predictedExistingGrowthBytes,
      requestedPredictedBytes: input.requestedPredictedBytes,
      inFlightPredictedBytes: input.inFlightPredictedBytes,
      remainingAfterAdmissionBytes,
    };
  }
  if ((input.recentOomEvents ?? 0n) > 0n && remainingAfterAdmissionBytes < safetyReserveBytes * 2n) {
    return {
      allowed: false,
      reason: "recent OOM events require an enlarged effective safety margin",
      nodeMemoryTotalBytes: input.nodeMemoryTotalBytes,
      nodeMemoryAvailableBytes: input.nodeMemoryAvailableBytes,
      safetyReserveBytes,
      currentAppMemoryBytes: input.currentAppMemoryBytes,
      predictedExistingGrowthBytes,
      requestedPredictedBytes: input.requestedPredictedBytes,
      inFlightPredictedBytes: input.inFlightPredictedBytes,
      remainingAfterAdmissionBytes,
    };
  }
  return {
    allowed: remainingAfterAdmissionBytes >= safetyReserveBytes,
    reason: remainingAfterAdmissionBytes >= safetyReserveBytes
      ? "predicted growth fits while preserving the physical safety reserve"
      : "predicted growth would consume the physical safety reserve",
    nodeMemoryTotalBytes: input.nodeMemoryTotalBytes,
    nodeMemoryAvailableBytes: input.nodeMemoryAvailableBytes,
    safetyReserveBytes,
    currentAppMemoryBytes: input.currentAppMemoryBytes,
    predictedExistingGrowthBytes,
    requestedPredictedBytes: input.requestedPredictedBytes,
    inFlightPredictedBytes: input.inFlightPredictedBytes,
    remainingAfterAdmissionBytes,
  };
}