import { describe, expect, it } from "vitest";
import {
  buildNfsDriverOptions,
  resolveLocalStoragePath,
} from "./storage-backend.logic";

describe("Stage 14 storage backend logic", () => {
  it("maps a logical /rp path underneath the local storage mount", () => {
    expect(
      resolveLocalStoragePath(
        "/mnt/resourceportal-storage",
        "/rp",
        "/rp/volumes/tenant-a/volume-a",
      ),
    ).toBe("/mnt/resourceportal-storage/volumes/tenant-a/volume-a");
  });

  it("rejects a logical path that escapes the backend base path", () => {
    expect(() =>
      resolveLocalStoragePath(
        "/mnt/resourceportal-storage",
        "/rp",
        "/rp/volumes/../..//outside",
      ),
    ).toThrow("outside StorageBackend basePath");
  });

  it("keeps the backend root mapped directly to the storage mount root", () => {
    expect(
      resolveLocalStoragePath("/mnt/resourceportal-storage", "/rp", "/rp"),
    ).toBe("/mnt/resourceportal-storage");
  });

  it("builds Docker local-driver options for NFS-Ganesha", () => {
    expect(
      buildNfsDriverOptions(
        "10.0.0.15",
        "4.1",
        "/rp/volumes/tenant-a/volume-a",
      ),
    ).toEqual({
      type: "nfs",
      o: "addr=10.0.0.15,nfsvers=4.1,rw",
      device: ":/rp/volumes/tenant-a/volume-a",
    });
  });
});
