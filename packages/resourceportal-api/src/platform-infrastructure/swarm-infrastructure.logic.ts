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
