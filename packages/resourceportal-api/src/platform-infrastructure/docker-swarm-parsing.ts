import {
  RemoteLocationAvailability,
  RemoteLocationRole,
  RemoteLocationStatus,
} from "./swarm-infrastructure.logic";

export type ObservedSwarmNode = {
  swarmNodeId: string;
  hostname: string;
  role: RemoteLocationRole;
  status: RemoteLocationStatus;
  availability: RemoteLocationAvailability;
  cpuNano: bigint;
  memoryBytes: bigint;
  labels: Record<string, string>;
};

type DockerNodeInspect = {
  ID?: unknown;
  Spec?: {
    Role?: unknown;
    Availability?: unknown;
    Labels?: unknown;
  };
  Description?: {
    Hostname?: unknown;
    Resources?: {
      NanoCPUs?: unknown;
      MemoryBytes?: unknown;
    };
  };
  Status?: {
    State?: unknown;
  };
};

export function parseDockerNodeInspect(value: unknown): ObservedSwarmNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const node = value as DockerNodeInspect;
  const role = parseRole(node.Spec?.Role);
  const availability = parseAvailability(node.Spec?.Availability);
  const cpuNano = parseNonNegativeInteger(node.Description?.Resources?.NanoCPUs);
  const memoryBytes = parseNonNegativeInteger(
    node.Description?.Resources?.MemoryBytes,
  );

  if (
    typeof node.ID !== "string" ||
    node.ID.length === 0 ||
    typeof node.Description?.Hostname !== "string" ||
    node.Description.Hostname.length === 0 ||
    !role ||
    !availability ||
    cpuNano === null ||
    memoryBytes === null
  ) {
    return null;
  }

  return {
    swarmNodeId: node.ID,
    hostname: node.Description.Hostname,
    role,
    status: parseStatus(node.Status?.State),
    availability,
    cpuNano,
    memoryBytes,
    labels: parseLabels(node.Spec?.Labels),
  };
}

function parseRole(value: unknown): RemoteLocationRole | null {
  if (value === "manager") {
    return "Manager";
  }

  if (value === "worker") {
    return "Worker";
  }

  return null;
}

function parseAvailability(value: unknown): RemoteLocationAvailability | null {
  if (value === "active") {
    return "Active";
  }

  if (value === "pause") {
    return "Pause";
  }

  if (value === "drain") {
    return "Drain";
  }

  return null;
}

function parseStatus(value: unknown): RemoteLocationStatus {
  if (value === "ready") {
    return "Ready";
  }

  if (value === "down") {
    return "Down";
  }

  if (value === "disconnected") {
    return "Disconnected";
  }

  return "Unknown";
}

function parseNonNegativeInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }

  return BigInt(value);
}

function parseLabels(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
