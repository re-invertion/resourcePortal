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
  gpuUuids?: string[];
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
      GenericResources?: unknown;
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
    ...extractNamedNvidiaGpus(node.Description?.Resources?.GenericResources),
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

/** Docker daemon-advertised UUIDs, not user-controlled node labels. */
function extractNamedNvidiaGpus(value: unknown): { gpuUuids?: string[] } {
  if (!Array.isArray(value)) return {};
  const uuids: string[] = [];
  for (const resource of value) {
    if (!resource || typeof resource !== "object") continue;
    const named: unknown = (resource as Record<string, unknown>).NamedResourceSpec;
    if (!named || typeof named !== "object") continue;
    const spec = named as Record<string, unknown>;
    if (spec.Kind !== "NVIDIA-GPU") continue;
    if (typeof spec.Value !== "string" ||
        !/^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(spec.Value) ||
        uuids.some((value) => value.toLowerCase() === (spec.Value as string).toLowerCase())) {
      // Malformed/duplicated UUIDs must never be treated as capacity.
      return {};
    }
    uuids.push(spec.Value);
  }
  return uuids.length ? { gpuUuids: uuids.sort() } : {};
}
