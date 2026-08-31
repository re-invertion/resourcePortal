export type RemoteLocationStatus =
  | "Ready"
  | "Down"
  | "Unknown"
  | "Disconnected"
  | "Removed";

export type RemoteLocationAvailability = "Active" | "Pause" | "Drain";
export type RemoteLocationRole = "Manager" | "Worker";
export type InfrastructureHealth =
  | "Healthy"
  | "Degraded"
  | "Unhealthy"
  | "Unknown";

export type ExistingRemoteLocation = {
  id: string;
  swarmNodeId: string;
  status: RemoteLocationStatus;
};

export function deriveRemoteLocationHealth(
  status: RemoteLocationStatus,
  availability: RemoteLocationAvailability,
): InfrastructureHealth {
  if (
    status === "Down" ||
    status === "Disconnected" ||
    status === "Removed"
  ) {
    return "Unhealthy";
  }

  if (status !== "Ready") {
    return "Unknown";
  }

  return availability === "Active" ? "Healthy" : "Degraded";
}

export function deriveSchedulableCapacity(
  status: RemoteLocationStatus,
  availability: RemoteLocationAvailability,
  cpuNano: bigint,
  memoryBytes: bigint,
) {
  const schedulable = status === "Ready" && availability === "Active";
  return {
    availableCpuNano: schedulable ? cpuNano : 0n,
    availableMemoryBytes: schedulable ? memoryBytes : 0n,
  };
}

export function deriveSwarmClusterHealth(
  nodes: Array<{
    role: RemoteLocationRole;
    status: RemoteLocationStatus;
  }>,
): InfrastructureHealth {
  const hasReadyManager = nodes.some(
    (node) => node.role === "Manager" && node.status === "Ready",
  );

  if (!hasReadyManager) {
    return "Unhealthy";
  }

  return nodes.every((node) => node.status === "Ready")
    ? "Healthy"
    : "Degraded";
}

export function parseNodeCapabilities(labels: Record<string, string>) {
  const parsedGpuCount = Number.parseInt(
    labels["resourceportal.gpu.count"] ?? "0",
    10,
  );
  const gpuCount =
    Number.isFinite(parsedGpuCount) && parsedGpuCount >= 0 ? parsedGpuCount : 0;
  const networkCapabilities = Array.from(
    new Set(
      (labels["resourceportal.network.capabilities"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort();

  return { gpuCount, networkCapabilities };
}

export function planInventoryReconciliation(
  existing: ExistingRemoteLocation[],
  observed: Array<{ swarmNodeId: string }>,
) {
  const existingByNodeId = new Map(
    existing.map((remoteLocation) => [remoteLocation.swarmNodeId, remoteLocation]),
  );
  const observedNodeIds = new Set(observed.map((node) => node.swarmNodeId));

  return {
    observations: observed.map((node) => {
      const current = existingByNodeId.get(node.swarmNodeId);
      return {
        swarmNodeId: node.swarmNodeId,
        remoteLocationId: current?.id ?? null,
        discovered: !current,
      };
    }),
    removed: existing
      .filter(
        (remoteLocation) =>
          remoteLocation.status !== "Removed" &&
          !observedNodeIds.has(remoteLocation.swarmNodeId),
      )
      .map((remoteLocation) => ({
        id: remoteLocation.id,
        swarmNodeId: remoteLocation.swarmNodeId,
      })),
  };
}
