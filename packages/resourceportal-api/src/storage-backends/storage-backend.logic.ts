import { HealthState } from "@prisma/client";
import { posix, resolve } from "node:path";

export type CephCapacity = {
  totalBytes: bigint;
  availableBytes: bigint;
};

export type NfsDriverOptions = {
  type: "nfs";
  o: string;
  device: string;
};

export function cephHealthToState(status: string): HealthState {
  switch (status.trim()) {
    case "HEALTH_OK":
      return HealthState.Healthy;
    case "HEALTH_WARN":
      return HealthState.Degraded;
    case "HEALTH_ERR":
      return HealthState.Unhealthy;
    default:
      return HealthState.Unknown;
  }
}

export function parseCephCapacity(payload: string): CephCapacity {
  const parsed = JSON.parse(payload) as {
    stats?: {
      total_bytes?: number | string;
      total_avail_bytes?: number | string;
    };
  };
  const totalBytes = toNonNegativeBigInt(parsed.stats?.total_bytes, "total_bytes");
  const availableBytes = toNonNegativeBigInt(
    parsed.stats?.total_avail_bytes,
    "total_avail_bytes",
  );

  if (availableBytes > totalBytes) {
    throw new Error("Ceph available capacity exceeds total capacity");
  }

  return { totalBytes, availableBytes };
}

export function resolveCephFsLocalPath(
  mountRoot: string,
  backendBasePath: string,
  logicalPath: string,
): string {
  const normalizedBase = posix.resolve("/", backendBasePath);
  const normalizedLogical = posix.resolve("/", logicalPath);

  if (
    normalizedLogical !== normalizedBase &&
    !normalizedLogical.startsWith(`${normalizedBase}/`)
  ) {
    throw new Error("CephFS logical path is outside StorageBackend basePath");
  }

  return resolve(mountRoot, normalizedLogical.slice(1));
}

export function buildNfsDriverOptions(
  server: string,
  nfsVersion: string,
  logicalPath: string,
): NfsDriverOptions {
  if (!server.trim()) {
    throw new Error("NFS_GANESHA_SERVER is required");
  }

  const normalizedPath = posix.resolve("/", logicalPath);

  return {
    type: "nfs",
    o: `addr=${server.trim()},nfsvers=${nfsVersion.trim() || "4.1"},rw`,
    device: `:${normalizedPath}`,
  };
}

function toNonNegativeBigInt(
  value: number | string | undefined,
  field: string,
): bigint {
  if (value === undefined) {
    throw new Error(`Ceph df is missing ${field}`);
  }

  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`Ceph df ${field} exceeds safe JSON integer precision`);
  }

  const parsed = BigInt(value);

  if (parsed < 0n) {
    throw new Error(`Ceph df ${field} must be non-negative`);
  }

  return parsed;
}
