import { ConfigService } from "@nestjs/config";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumeStorageService } from "./volume-storage.service";

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "rp-stage7-"));
  tempRoots.push(root);
  return root;
}

function serviceFor(root: string) {
  const config = {
    get: vi.fn((key: string, defaultValue: unknown) =>
      key === "RESOURCE_STORAGE_BASE_PATH" ? root : defaultValue,
    ),
  };
  return new VolumeStorageService(config as unknown as ConfigService);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("VolumeStorageService", () => {
  it("measures file bytes recursively without following symlinks", async () => {
    const root = await tempRoot();
    const storagePath = join(root, "volumes", "tenant-1", "volume-1");
    const nested = join(storagePath, "nested");
    const outside = join(root, "outside.txt");
    await mkdir(nested, { recursive: true });
    await writeFile(join(storagePath, "root.txt"), "12345");
    await writeFile(join(nested, "child.txt"), "1234567");
    await writeFile(outside, "this must not be counted");
    await symlink(outside, join(storagePath, "outside-link"));
    const service = serviceFor(root);
    await expect(service.measureUsedSize(storagePath)).resolves.toBe(12n);
  });

  it("reports zero bytes when the storage path does not exist yet", async () => {
    const root = await tempRoot();
    const service = serviceFor(root);
    await expect(service.measureUsedSize(join(root, "volumes", "tenant-1", "missing"))).resolves.toBe(0n);
  });

  it("rejects deletion when the persisted path is outside the expected volume path", async () => {
    const root = await tempRoot();
    const unsafePath = join(root, "volumes", "tenant-1", "other-volume");
    await mkdir(unsafePath, { recursive: true });
    const service = serviceFor(root);
    await expect(service.deleteVolumeData({ tenantId: "tenant-1", volumeId: "volume-1", storagePath: unsafePath }))
      .rejects.toThrow("Unsafe volume storage path");
    await expect(lstat(unsafePath)).resolves.toBeDefined();
  });

  it("removes physical data without inspecting Docker named volumes", async () => {
    const root = await tempRoot();
    const storagePath = join(root, "volumes", "tenant-1", "volume-1");
    await mkdir(storagePath, { recursive: true });
    await writeFile(join(storagePath, "data.txt"), "data");
    const service = serviceFor(root);
    await service.deleteVolumeData({ tenantId: "tenant-1", volumeId: "volume-1", storagePath });
    await expect(lstat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
