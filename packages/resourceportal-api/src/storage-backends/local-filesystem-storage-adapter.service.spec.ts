import { ConfigService } from "@nestjs/config";
import { HealthState } from "@prisma/client";
import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFilesystemStorageAdapterService } from "./local-filesystem-storage-adapter.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  statfs: vi.fn(),
}));

const mockedLstat = vi.mocked(lstat);
const mockedMkdir = vi.mocked(mkdir);
const mockedReaddir = vi.mocked(readdir);
const mockedRm = vi.mocked(rm);
const mockedStatfs = vi.mocked(statfs);

const backend = {
  id: "00000000-0000-4000-8000-000000000014",
  basePath: "/rp",
  volumeBasePath: "/rp/volumes",
  secretBasePath: "/rp/secrets",
};

function adapterFor(input?: {
  filesystem?: string;
  options?: string;
  projectIdReadback?: number;
}) {
  const config = {
    get: vi.fn((key: string, defaultValue: unknown) => {
      const values: Record<string, unknown> = {
        STORAGE_MOUNT_ROOT: "/mnt/resourceportal-storage",
        STORAGE_FINDMNT_CLI: "findmnt",
        STORAGE_XFS_QUOTA_CLI: "xfs_quota",
        STORAGE_LSATTR_CLI: "lsattr",
        NFS_GANESHA_SERVER: "10.0.0.15",
        NFS_GANESHA_VERSION: "4.1",
      };
      return values[key] ?? defaultValue;
    }),
  };
  const runner = {
    run: vi.fn((program: string, args: string[]) => {
      if (program === "findmnt" && args.includes("FSTYPE")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${input?.filesystem ?? "xfs"}\n`,
          stderr: "",
        });
      }
      if (program === "findmnt" && args.includes("OPTIONS")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${input?.options ?? "rw,relatime,prjquota"}\n`,
          stderr: "",
        });
      }
      if (program === "xfs_quota") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (program === "lsattr") {
        const path = args.at(-1) ?? "";
        return Promise.resolve({
          exitCode: 0,
          stdout: `${input?.projectIdReadback ?? 12001} -----------------P--- ${path}\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unexpected command" });
    }),
  };

  return {
    adapter: new LocalFilesystemStorageAdapterService(
      config as unknown as ConfigService,
      runner as unknown as StorageCommandRunnerService,
    ),
    runner,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStatfs.mockResolvedValue({
    bsize: 4096,
    blocks: 1000,
    bfree: 600,
    bavail: 500,
    files: 0,
    ffree: 0,
    type: 0,
  });
  mockedMkdir.mockResolvedValue(undefined);
  mockedRm.mockResolvedValue(undefined);
  mockedReaddir.mockResolvedValue([]);
});

describe("LocalFilesystemStorageAdapterService", () => {
  it("validates XFS with project quotas and reports statfs capacity", async () => {
    const { adapter } = adapterFor();

    await expect(adapter.validateLocal()).resolves.toEqual({
      health: HealthState.Healthy,
      filesystem: "xfs",
      capacityTotal: 4096000n,
      capacityAvailable: 2048000n,
    });
  });

  it("accepts ext4 only when project quota is enabled", async () => {
    const { adapter } = adapterFor({ filesystem: "ext4", options: "rw,relatime,prjquota" });

    await expect(adapter.validateLocal()).resolves.toMatchObject({
      health: HealthState.Healthy,
      filesystem: "ext4",
    });
  });

  it("rejects a supported filesystem when project quota is missing", async () => {
    const { adapter } = adapterFor({ filesystem: "xfs", options: "rw,relatime" });

    await expect(adapter.validateLocal()).rejects.toThrow("project quota");
  });

  it("rejects filesystems outside the v1 XFS/ext4 contract", async () => {
    const { adapter } = adapterFor({ filesystem: "btrfs", options: "rw,relatime,prjquota" });

    await expect(adapter.validateLocal()).rejects.toThrow("Unsupported storage filesystem");
  });

  it("provisions a Volume with a numeric project quota", async () => {
    const { adapter, runner } = adapterFor();
    const localPath = "/mnt/resourceportal-storage/volumes/tenant-a/volume-a";

    await expect(
      adapter.provisionVolume(backend, {
        tenantId: "tenant-a",
        volumeId: "volume-a",
        sizeBytes: 4096n,
        projectId: 12001,
      }),
    ).resolves.toEqual({ storagePath: "/rp/volumes/tenant-a/volume-a" });

    expect(mockedMkdir).toHaveBeenCalledWith(localPath, { recursive: true });
    expect(runner.run).toHaveBeenCalledWith("xfs_quota", [
      "-P/dev/null",
      "-D/dev/null",
      "-x",
      "-f",
      "/mnt/resourceportal-storage",
      "-c",
      "limit -p bhard=4096 bsoft=4096 12001",
    ]);
    expect(runner.run).toHaveBeenCalledWith("xfs_quota", [
      "-P/dev/null",
      "-D/dev/null",
      "-x",
      "-f",
      "/mnt/resourceportal-storage",
      "-c",
      `project -s -p ${localPath} 12001`,
    ]);
    expect(runner.run).toHaveBeenCalledWith("lsattr", ["-pd", localPath]);
  });

  it("uses the same project-quota contract for ext4", async () => {
    const { adapter, runner } = adapterFor({ filesystem: "ext4" });

    await adapter.provisionVolume(backend, {
      tenantId: "tenant-a",
      volumeId: "volume-a",
      sizeBytes: 8192n,
      projectId: 12002,
    });

    expect(runner.run).toHaveBeenCalledWith("xfs_quota", [
      "-P/dev/null",
      "-D/dev/null",
      "-x",
      "-f",
      "/mnt/resourceportal-storage",
      "-c",
      "limit -p bhard=8192 bsoft=8192 12002",
    ]);
  });

  it("removes a newly-created directory when project-id verification fails", async () => {
    const { adapter } = adapterFor({ projectIdReadback: 12099 });
    const localPath = "/mnt/resourceportal-storage/volumes/tenant-a/volume-a";

    await expect(
      adapter.provisionVolume(backend, {
        tenantId: "tenant-a",
        volumeId: "volume-a",
        sizeBytes: 4096n,
        projectId: 12001,
      }),
    ).rejects.toThrow("project quota verification failed");

    expect(mockedRm).toHaveBeenCalledWith(localPath, { recursive: true, force: true });
  });

  it("resizes the hard and soft project quota without changing the project id", async () => {
    const { adapter, runner } = adapterFor();

    await adapter.resizeVolume(
      backend,
      "/rp/volumes/tenant-a/volume-a",
      16384n,
      12001,
    );

    expect(runner.run).toHaveBeenCalledWith("xfs_quota", [
      "-P/dev/null",
      "-D/dev/null",
      "-x",
      "-f",
      "/mnt/resourceportal-storage",
      "-c",
      "limit -p bhard=16384 bsoft=16384 12001",
    ]);
  });

  it("measures used bytes recursively without following symlinks", async () => {
    const { adapter } = adapterFor();
    const root = "/mnt/resourceportal-storage/volumes/tenant-a/volume-a";
    mockedReaddir.mockImplementation((path) => {
      if (String(path) === root) return Promise.resolve(["a.txt", "nested", "link"] as never);
      if (String(path) === `${root}/nested`) return Promise.resolve(["b.txt"] as never);
      return Promise.resolve([] as never);
    });
    mockedLstat.mockImplementation((path) => {
      const value = String(path);
      if (value.endsWith("/a.txt")) {
        return Promise.resolve({
          size: 5,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        } as never);
      }
      if (value.endsWith("/nested")) {
        return Promise.resolve({
          size: 0,
          isSymbolicLink: () => false,
          isDirectory: () => true,
          isFile: () => false,
        } as never);
      }
      if (value.endsWith("/b.txt")) {
        return Promise.resolve({
          size: 7,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        } as never);
      }
      return Promise.resolve({
        size: 99,
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false,
      } as never);
    });

    await expect(
      adapter.measureUsedSize(backend, "/rp/volumes/tenant-a/volume-a"),
    ).resolves.toBe(12n);
  });

  it("returns NFS-Ganesha runtime driver options", () => {
    const { adapter } = adapterFor();

    expect(adapter.runtimeDriverOptions("/rp/volumes/tenant-a/volume-a")).toEqual({
      type: "nfs",
      o: "addr=10.0.0.15,nfsvers=4.1,rw",
      device: ":/rp/volumes/tenant-a/volume-a",
    });
  });
});
