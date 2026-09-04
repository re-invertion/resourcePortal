import { ConfigService } from "@nestjs/config";
import { HealthState } from "@prisma/client";
import { statfs } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFilesystemStorageAdapterService } from "./local-filesystem-storage-adapter.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

vi.mock("node:fs/promises", () => ({
  statfs: vi.fn(),
}));

const mockedStatfs = vi.mocked(statfs);

function adapterFor(input?: { filesystem?: string; options?: string }) {
  const config = {
    get: vi.fn((key: string, defaultValue: unknown) => {
      const values: Record<string, unknown> = {
        STORAGE_MOUNT_ROOT: "/mnt/resourceportal-storage",
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
  mockedStatfs.mockReset();
  mockedStatfs.mockResolvedValue({
    bsize: 4096,
    blocks: 1000,
    bfree: 600,
    bavail: 500,
    files: 0,
    ffree: 0,
    type: 0,
  });
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
});
