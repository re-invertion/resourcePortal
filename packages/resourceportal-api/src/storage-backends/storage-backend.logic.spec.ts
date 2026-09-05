import { describe, expect, it } from "vitest";
import { resolveLocalStoragePath } from "./storage-backend.logic";

describe("Stage 14 storage backend logic", () => {
  it("maps a physical backend path underneath the local storage mount", () => {
    expect(
      resolveLocalStoragePath(
        "/srv/resource-portal/storage",
        "/srv/resource-portal/storage",
        "/srv/resource-portal/storage/volumes/tenant-a/volume-a",
      ),
    ).toBe("/srv/resource-portal/storage/volumes/tenant-a/volume-a");
  });

  it("rejects a path that escapes the backend base path", () => {
    expect(() =>
      resolveLocalStoragePath(
        "/srv/resource-portal/storage",
        "/srv/resource-portal/storage",
        "/srv/resource-portal/outside",
      ),
    ).toThrow("outside StorageBackend basePath");
  });

  it("keeps the backend root mapped directly to the storage mount root", () => {
    expect(
      resolveLocalStoragePath(
        "/srv/resource-portal/storage",
        "/srv/resource-portal/storage",
        "/srv/resource-portal/storage",
      ),
    ).toBe("/srv/resource-portal/storage");
  });
});
