import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_RUNTIME_ROOT,
  DEFAULT_SECRET_RUNTIME_ROOT,
  DEFAULT_STORAGE_BASE_PATH,
  DEFAULT_VOLUME_RUNTIME_ROOT,
  physicalSecretPath,
  physicalVolumePath,
  volumeRuntimePath,
} from "./storage-paths";

describe("Wiki storage paths", () => {
  it("uses the approved defaults", () => {
    expect(DEFAULT_STORAGE_BASE_PATH).toBe("/srv/resource-portal/storage");
    expect(DEFAULT_VOLUME_RUNTIME_ROOT).toBe("/mnt/resourceportal/volumes");
    expect(DEFAULT_SECRET_RUNTIME_ROOT).toBe("/mnt/resourceportal/secrets");
    expect(DEFAULT_PLATFORM_RUNTIME_ROOT).toBe("/mnt/resourceportal/platform");
  });

  it("builds physical and runtime Volume paths", () => {
    expect(physicalVolumePath(DEFAULT_STORAGE_BASE_PATH, "tenant-a", "volume-a"))
      .toBe("/srv/resource-portal/storage/volumes/tenant-a/volume-a");
    expect(volumeRuntimePath(DEFAULT_VOLUME_RUNTIME_ROOT, "tenant-a", "volume-a"))
      .toBe("/mnt/resourceportal/volumes/tenant-a/volume-a");
  });

  it("builds protected Secret paths", () => {
    expect(physicalSecretPath(DEFAULT_STORAGE_BASE_PATH, "tenant-a", "app-a", "api-key"))
      .toBe("/srv/resource-portal/storage/secrets/tenant-a/app-a/api-key");
  });

  it("rejects traversal", () => {
    expect(() => physicalVolumePath(DEFAULT_STORAGE_BASE_PATH, "../outside", "volume-a"))
      .toThrow("Storage path segment is invalid");
  });
});
