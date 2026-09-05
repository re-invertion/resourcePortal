import { posix } from "node:path";

export const DEFAULT_STORAGE_BASE_PATH = "/srv/resource-portal/storage";
export const DEFAULT_VOLUME_RUNTIME_ROOT = "/mnt/resourceportal/volumes";
export const DEFAULT_SECRET_RUNTIME_ROOT = "/mnt/resourceportal/secrets";
export const DEFAULT_PLATFORM_RUNTIME_ROOT = "/mnt/resourceportal/platform";

function assertSafeSegment(value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("Storage path segment is invalid");
  }
  return value;
}

export function assertPathWithin(root: string, candidate: string): string {
  const normalizedRoot = posix.resolve("/", root);
  const normalizedCandidate = posix.resolve("/", candidate);
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("Storage path is outside configured root");
  }
  return normalizedCandidate;
}

export function physicalVolumePath(
  basePath: string,
  tenantId: string,
  volumeId: string,
): string {
  return assertPathWithin(
    basePath,
    posix.join(
      basePath,
      "volumes",
      assertSafeSegment(tenantId),
      assertSafeSegment(volumeId),
    ),
  );
}

export function physicalSecretPath(
  basePath: string,
  tenantId: string,
  appGroupId: string,
  secretName: string,
): string {
  return assertPathWithin(
    basePath,
    posix.join(
      basePath,
      "secrets",
      assertSafeSegment(tenantId),
      assertSafeSegment(appGroupId),
      assertSafeSegment(secretName),
    ),
  );
}

export function volumeRuntimePath(
  runtimeRoot: string,
  tenantId: string,
  volumeId: string,
): string {
  return assertPathWithin(
    runtimeRoot,
    posix.join(
      runtimeRoot,
      assertSafeSegment(tenantId),
      assertSafeSegment(volumeId),
    ),
  );
}
