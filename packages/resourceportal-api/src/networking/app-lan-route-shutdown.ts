/**
 * Clean up only RP-owned (route proto 201) entries inside running tenant
 * namespaces before removing the global route agent during image rollback.
 * Returning valid, unique PIDs allows the privileged runner to use nsenter
 * without trusting container names or data from unrelated workloads.
 */
export function managedTenantRoutePids(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error("Invalid Docker inspect response");
  const pids = new Set<number>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as {
      State?: { Running?: boolean; Pid?: number };
      Config?: { Labels?: Record<string, string> };
      HostConfig?: { NetworkMode?: string };
      NetworkSettings?: { Networks?: Record<string, unknown> };
    };
    const pid = entry.State?.Pid;
    if (entry.State?.Running !== true ||
      entry.Config?.Labels?.["resourceportal.workload"] !== "tenant" ||
      entry.HostConfig?.NetworkMode === "host" ||
      !Object.keys(entry.NetworkSettings?.Networks ?? {})
        .some(name => /^rp-network-[0-9a-f-]{36}$/i.test(name)) ||
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2) continue;
    pids.add(pid);
  }
  return [...pids];
}

export function managedRouteFlushArgs(): string[] {
  return ["-4", "route", "flush", "proto", "201"];
}
