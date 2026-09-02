const quotaKeys = [
  "cpu",
  "memoryBytes",
  "gpu",
  "storageBytes",
  "maxSingleApps",
  "maxVolumes",
] as const;

const emptyQuota = {
  cpu: 0,
  memoryBytes: 0,
  gpu: 0,
  storageBytes: 0,
  maxSingleApps: 0,
  maxVolumes: 0,
};

function pickQuota(value: Record<string, unknown>) {
  const selected: Record<string, unknown> = {};
  for (const key of quotaKeys) {
    if (value[key] !== undefined) selected[key] = value[key];
  }
  return selected;
}

export function buildQuotaMutation(
  current: unknown,
  submitted: Record<string, unknown>,
) {
  const patch = pickQuota(submitted);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return patch;
  }
  return { ...emptyQuota, ...patch };
}
