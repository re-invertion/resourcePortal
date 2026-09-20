export function internalPortExposureCountFromStackConfig(
  stackConfig: string | null | undefined,
): number {
  if (!stackConfig) return 0;
  try {
    const parsed = JSON.parse(stackConfig) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    const singleApps = (parsed as { singleApps?: unknown }).singleApps;
    if (!Array.isArray(singleApps)) return 0;

    let count = 0;
    for (const singleApp of singleApps) {
      if (!singleApp || typeof singleApp !== "object" || Array.isArray(singleApp)) {
        continue;
      }
      const exposures = (singleApp as Record<string, unknown>)[
        "internalPortExposures"
      ];
      if (Array.isArray(exposures)) count += exposures.length;
    }
    return count;
  } catch {
    return 0;
  }
}

export function stackConfigHasInternalPortExposures(
  stackConfig: string | null | undefined,
) {
  return internalPortExposureCountFromStackConfig(stackConfig) > 0;
}
