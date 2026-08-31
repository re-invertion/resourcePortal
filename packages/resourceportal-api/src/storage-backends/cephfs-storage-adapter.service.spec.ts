import { ConfigService } from "@nestjs/config";
import { HealthState } from "@prisma/client";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CephFsStorageAdapterService } from "./cephfs-storage-adapter.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

const roots: string[] = [];
const backend = {
  id: "00000000-0000-4000-8000-000000000014",
  basePath: "/rp",
  volumeBasePath: "/rp/volumes",
  secretBasePath: "/rp/secrets",
};

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "rp-stage14-"));
  roots.push(root);
  return root;
}

function adapterFor(root: string, quotaReadback = "4096") {
  const config = {
    get: vi.fn((key: string, defaultValue: unknown) => {
      const values: Record<string, unknown> = {
        CEPHFS_MOUNT_ROOT: root,
        CEPH_CLI: "ceph",
        CEPHFS_SETXATTR_CLI: "setfattr",
        CEPHFS_GETXATTR_CLI: "getfattr",
        NFS_GANESHA_SERVER: "10.0.0.15",
        NFS_GANESHA_VERSION: "4.1",
      };
      return values[key] ?? defaultValue;
    }),
  };
  const runner = {
    run: vi.fn((program: string, args: string[]) => {
      if (program === "ceph" && args[0] === "health") {
        return Promise.resolve({ exitCode: 0, stdout: '{"status":"HEALTH_OK"}', stderr: "" });
      }
      if (program === "ceph" && args[0] === "df") {
        return Promise.resolve({
          exitCode: 0,
          stdout: '{"stats":{"total_bytes":10000,"total_avail_bytes":6000}}',
          stderr: "",
        });
      }
      if (program === "getfattr") {
        return Promise.resolve({ exitCode: 0, stdout: quotaReadback, stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }),
  };
  const adapter = new CephFsStorageAdapterService(
    config as unknown as ConfigService,
    runner as unknown as StorageCommandRunnerService,
  );
  return { adapter, runner };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CephFsStorageAdapterService", () => {
  it("creates a Volume directory and verifies ceph.quota.max_bytes", async () => {
    const root = await tempRoot();
    const { adapter, runner } = adapterFor(root);

    const result = await adapter.provisionVolume(backend, {
      tenantId: "tenant-a",
      volumeId: "volume-a",
      sizeBytes: 4096n,
    });

    expect(result.storagePath).toBe("/rp/volumes/tenant-a/volume-a");
    await expect(lstat(join(root, "rp/volumes/tenant-a/volume-a"))).resolves.toBeDefined();
    expect(runner.run).toHaveBeenCalledWith(
      "setfattr",
      ["-n", "ceph.quota.max_bytes", "-v", "4096", join(root, "rp/volumes/tenant-a/volume-a")],
    );
    expect(runner.run).toHaveBeenCalledWith(
      "getfattr",
      ["--only-values", "-n", "ceph.quota.max_bytes", join(root, "rp/volumes/tenant-a/volume-a")],
    );
  });

  it("removes a newly-created directory when quota verification mismatches", async () => {
    const root = await tempRoot();
    const { adapter } = adapterFor(root, "2048");
    const path = join(root, "rp/volumes/tenant-a/volume-a");

    await expect(
      adapter.provisionVolume(backend, {
        tenantId: "tenant-a",
        volumeId: "volume-a",
        sizeBytes: 4096n,
      }),
    ).rejects.toThrow("CephFS quota verification failed");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("grows and verifies the physical quota during resize", async () => {
    const root = await tempRoot();
    const { adapter, runner } = adapterFor(root, "8192");
    const logical = "/rp/volumes/tenant-a/volume-a";
    await mkdir(join(root, "rp/volumes/tenant-a/volume-a"), { recursive: true });

    await adapter.resizeVolume(backend, logical, 8192n);

    expect(runner.run).toHaveBeenCalledWith(
      "setfattr",
      ["-n", "ceph.quota.max_bytes", "-v", "8192", join(root, "rp/volumes/tenant-a/volume-a")],
    );
  });

  it("measures used bytes recursively without following symlinks", async () => {
    const root = await tempRoot();
    const { adapter } = adapterFor(root);
    const path = join(root, "rp/volumes/tenant-a/volume-a");
    const nested = join(path, "nested");
    const outside = join(root, "outside.txt");
    await mkdir(nested, { recursive: true });
    await writeFile(join(path, "a.txt"), "12345");
    await writeFile(join(nested, "b.txt"), "1234567");
    await writeFile(outside, "not-counted");
    await symlink(outside, join(path, "outside-link"));

    await expect(adapter.measureUsedSize(backend, "/rp/volumes/tenant-a/volume-a")).resolves.toBe(12n);
  });

  it("returns health, capacity and NFS runtime options", async () => {
    const root = await tempRoot();
    const { adapter } = adapterFor(root);

    await expect(adapter.validateLocal()).resolves.toEqual({
      health: HealthState.Healthy,
      capacityTotal: 10000n,
      capacityAvailable: 6000n,
    });
    expect(adapter.runtimeDriverOptions("/rp/volumes/tenant-a/volume-a")).toEqual({
      type: "nfs",
      o: "addr=10.0.0.15,nfsvers=4.1,rw",
      device: ":/rp/volumes/tenant-a/volume-a",
    });
  });
});
