import { posix, resolve } from "node:path";

export type NfsDriverOptions = {
  type: "nfs";
  o: string;
  device: string;
};

export function resolveLocalStoragePath(
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
    throw new Error("Storage logical path is outside StorageBackend basePath");
  }

  const relativePath = posix.relative(normalizedBase, normalizedLogical);
  return resolve(mountRoot, relativePath);
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
