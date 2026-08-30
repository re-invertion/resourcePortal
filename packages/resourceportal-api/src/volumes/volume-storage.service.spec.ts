import { ConfigService } from "@nestjs/config";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    get: vi.fn((key: string, defaultValue: unknown) => {
      if (key === "RESOURCE_STORAGE_ROOT") {
        return root;
      }
      return defaultValue;
    }),
  };

  return new VolumeStorageService(config as unknown as ConfigService);
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("VolumeStorageService", () => {
  it("measures file bytes recursively without following symlinks", async () => {
    const root = await tempRoot();
    const storagePath = join(root, "tenant-1", "volume-1");
    const nested = join(storagePath, "nested");
    const outside = join(root, "outside.txt");
    await mkdir(nested, { recursive: true });
    await writeFile(join(storagePath, "root.txt"), "12345");
    await writeFile(join(nested, "child.txt"), "1234567");
    await writeFile(outside, "this must not be counted");
    await symlink(outside, join(storagePath, "outside-link"));
    const service = serviceFor(root);

    const used = await service.measureUsedSize(storagePath);

    expect(used).toBe(12n);
  });

  it("reports zero bytes when the storage path does not exist yet", async () => {
    const root = await tempRoot();
    const service = serviceFor(root);

    await expect(
      service.measureUsedSize(join(root, "tenant-1", "missing")),
    ).resolves.toBe(0n);
  });

  it("rejects deletion when the persisted path is outside the expected volume path", async () => {
    const root = await tempRoot();
    const unsafePath = join(root, "tenant-1", "other-volume");
    await mkdir(unsafePath, { recursive: true });
    const service = serviceFor(root);

    await expect(
      service.deleteVolumeData({
        tenantId: "tenant-1",
        volumeId: "volume-1",
        storagePath: unsafePath,
        dockerVolumeName: "rp_vol_volume_1",
      }),
    ).rejects.toThrow("Unsafe volume storage path");

    await expect(lstat(unsafePath)).resolves.toBeDefined();
  });

  it("treats an already-missing Docker volume as idempotent and removes the directory", async () => {
    const root = await tempRoot();
    const storagePath = join(root, "tenant-1", "volume-1");
    await mkdir(storagePath, { recursive: true });
    await writeFile(join(storagePath, "data.txt"), "data");
    const service = serviceFor(root);
    const runDocker = vi.fn(() =>
      Promise.resolve({
        command: "docker volume inspect rp_vol_volume_1",
        exitCode: 1,
        stdout: "",
        stderr: "Error: No such volume: rp_vol_volume_1",
      }),
    );
    (
      service as unknown as {
        runDocker: typeof runDocker;
      }
    ).runDocker = runDocker;

    await service.deleteVolumeData({
      tenantId: "tenant-1",
      volumeId: "volume-1",
      storagePath,
      dockerVolumeName: "rp_vol_volume_1",
    });

    await expect(lstat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the directory when Docker cannot be inspected safely", async () => {
    const root = await tempRoot();
    const storagePath = join(root, "tenant-1", "volume-1");
    await mkdir(storagePath, { recursive: true });
    const service = serviceFor(root);
    const runDocker = vi.fn(() =>
      Promise.resolve({
        command: "docker volume inspect rp_vol_volume_1",
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
      }),
    );
    (
      service as unknown as {
        runDocker: typeof runDocker;
      }
    ).runDocker = runDocker;

    await expect(
      service.deleteVolumeData({
        tenantId: "tenant-1",
        volumeId: "volume-1",
        storagePath,
        dockerVolumeName: "rp_vol_volume_1",
      }),
    ).rejects.toThrow("Docker volume inspect failed");

    await expect(lstat(storagePath)).resolves.toBeDefined();
  });
});
