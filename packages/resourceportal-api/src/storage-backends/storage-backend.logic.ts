import { posix, resolve } from "node:path";

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
