import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HealthState } from "@prisma/client";
import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { posix } from "node:path";
import {
  buildNfsDriverOptions,
  resolveLocalStoragePath,
} from "./storage-backend.logic";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

export type LocalStorageFilesystem = "xfs" | "ext4";

export type LocalFilesystemBackendDescriptor = {
  id: string;
  basePath: string;
  volumeBasePath: string;
  secretBasePath: string;
};

@Injectable()
export class LocalFilesystemStorageAdapterService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validateLocal() {
    const filesystem = await this.validateMount();
    const mountRoot = this.mountRoot();
    const stats = await statfs(mountRoot);
    const blockSize = BigInt(stats.bsize);
    const capacityTotal = blockSize * BigInt(stats.blocks);
    const capacityAvailable = blockSize * BigInt(stats.bavail);

    if (capacityTotal < 0n || capacityAvailable < 0n || capacityAvailable > capacityTotal) {
      throw new InternalServerErrorException("Storage filesystem returned invalid capacity data");
    }

    return {
      health: HealthState.Healthy,
      filesystem,
      capacityTotal,
      capacityAvailable,
    };
  }

  async provisionVolume(
    backend: LocalFilesystemBackendDescriptor,
    input: {
      tenantId: string;
      volumeId: string;
      sizeBytes: bigint;
      projectId: number;
    },
  ) {
    this.assertProjectId(input.projectId);
    const filesystem = await this.validateMount();

    const storagePath = posix.join(
      backend.volumeBasePath,
      input.tenantId,
      input.volumeId,
    );
    const localPath = this.localPath(backend, storagePath);
    await mkdir(localPath, { recursive: true });

    try {
      await this.applyProjectLimit(filesystem, input.projectId, input.sizeBytes);
      await this.assignProject(filesystem, localPath, input.projectId);
      await this.verifyProject(localPath, input.projectId);
    } catch (error) {
      await rm(localPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return { storagePath };
  }

  async resizeVolume(
    backend: LocalFilesystemBackendDescriptor,
    storagePath: string,
    sizeBytes: bigint,
    projectId: number,
  ) {
    this.assertProjectId(projectId);
    const filesystem = await this.validateMount();
    const localPath = this.localPath(backend, storagePath);
    await this.verifyProject(localPath, projectId);
    await this.applyProjectLimit(filesystem, projectId, sizeBytes);
  }

  async deleteVolume(
    backend: LocalFilesystemBackendDescriptor,
    storagePath: string,
  ) {
    await rm(this.localPath(backend, storagePath), {
      recursive: true,
      force: true,
    });
  }

  async measureUsedSize(
    backend: LocalFilesystemBackendDescriptor,
    storagePath: string,
  ) {
    return this.measureDirectory(this.localPath(backend, storagePath));
  }

  runtimeDriverOptions(storagePath: string) {
    return buildNfsDriverOptions(
      this.config.get<string>("NFS_GANESHA_SERVER", ""),
      this.config.get<string>("NFS_GANESHA_VERSION", "4.1"),
      storagePath,
    );
  }

  private async validateMount(): Promise<LocalStorageFilesystem> {
    const mountRoot = this.mountRoot();
    const findmnt = this.config.get<string>("STORAGE_FINDMNT_CLI", "findmnt");

    const filesystemResult = await this.commands.run(findmnt, [
      "-n",
      "-o",
      "FSTYPE",
      "-T",
      mountRoot,
    ]);
    if (filesystemResult.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Unable to inspect storage filesystem: ${filesystemResult.stderr || filesystemResult.stdout}`,
      );
    }

    const filesystem = filesystemResult.stdout.trim().toLowerCase();
    if (!this.isSupportedFilesystem(filesystem)) {
      throw new InternalServerErrorException(
        `Unsupported storage filesystem: ${filesystem || "unknown"}; expected xfs or ext4`,
      );
    }

    const optionsResult = await this.commands.run(findmnt, [
      "-n",
      "-o",
      "OPTIONS",
      "-T",
      mountRoot,
    ]);
    if (optionsResult.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Unable to inspect storage mount options: ${optionsResult.stderr || optionsResult.stdout}`,
      );
    }

    const options = new Set(
      optionsResult.stdout
        .trim()
        .split(",")
        .map((option) => option.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!options.has("prjquota") && !options.has("pquota")) {
      throw new InternalServerErrorException(
        `Storage filesystem ${filesystem} is mounted without project quota support`,
      );
    }

    return filesystem;
  }

  private async applyProjectLimit(
    filesystem: LocalStorageFilesystem,
    projectId: number,
    sizeBytes: bigint,
  ) {
    if (sizeBytes < 0n) {
      throw new InternalServerErrorException("Storage quota size must be non-negative");
    }

    if (filesystem === "xfs") {
      const result = await this.runXfsQuota(
        `limit -p bhard=${sizeBytes.toString()} bsoft=${sizeBytes.toString()} ${projectId}`,
      );
      if (result.exitCode !== 0) {
        throw new InternalServerErrorException(
          `Storage project quota update failed: ${result.stderr || result.stdout}`,
        );
      }
      return;
    }

    const setquota = this.config.get<string>("STORAGE_SETQUOTA_CLI", "setquota");
    const blocks = ((sizeBytes + 1023n) / 1024n).toString();
    const result = await this.commands.run(setquota, [
      "-P",
      projectId.toString(),
      blocks,
      blocks,
      "0",
      "0",
      this.mountRoot(),
    ]);
    if (result.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Storage project quota update failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  private async assignProject(
    filesystem: LocalStorageFilesystem,
    localPath: string,
    projectId: number,
  ) {
    if (filesystem === "xfs") {
      const result = await this.runXfsQuota(`project -s -p ${localPath} ${projectId}`);
      if (result.exitCode !== 0) {
        throw new InternalServerErrorException(
          `Storage project assignment failed: ${result.stderr || result.stdout}`,
        );
      }
      return;
    }

    const chattr = this.config.get<string>("STORAGE_CHATTR_CLI", "chattr");
    const result = await this.commands.run(chattr, [
      "-p",
      projectId.toString(),
      "+P",
      localPath,
    ]);
    if (result.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Storage project assignment failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  private async verifyProject(localPath: string, projectId: number) {
    const lsattr = this.config.get<string>("STORAGE_LSATTR_CLI", "lsattr");
    const result = await this.commands.run(lsattr, ["-pd", localPath]);
    const readback = this.parseProjectId(result.stdout);

    if (result.exitCode !== 0 || readback !== projectId) {
      throw new InternalServerErrorException(
        `Storage project quota verification failed: expected ${projectId}, got ${readback ?? "unavailable"}`,
      );
    }
  }

  private runXfsQuota(command: string) {
    const cli = this.config.get<string>("STORAGE_XFS_QUOTA_CLI", "xfs_quota");
    return this.commands.run(cli, [
      "-P/dev/null",
      "-D/dev/null",
      "-x",
      "-f",
      this.mountRoot(),
      "-c",
      command,
    ]);
  }

  private parseProjectId(output: string) {
    const first = output.trim().split(/\s+/)[0];
    if (!first || !/^\d+$/.test(first)) return null;
    const parsed = Number(first);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private localPath(
    backend: LocalFilesystemBackendDescriptor,
    logicalPath: string,
  ) {
    return resolveLocalStoragePath(
      this.mountRoot(),
      backend.basePath,
      logicalPath,
    );
  }

  private mountRoot() {
    return this.config.get<string>(
      "STORAGE_MOUNT_ROOT",
      "/mnt/resourceportal-storage",
    );
  }

  private assertProjectId(projectId: number) {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || projectId > 2_147_483_647) {
      throw new InternalServerErrorException("Storage project id is invalid");
    }
  }

  private isSupportedFilesystem(value: string): value is LocalStorageFilesystem {
    return value === "xfs" || value === "ext4";
  }

  private async measureDirectory(path: string): Promise<bigint> {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if (this.hasCode(error, "ENOENT")) return 0n;
      throw error;
    }

    let total = 0n;
    for (const name of names) {
      const child = posix.join(path, name);
      let details;
      try {
        details = await lstat(child);
      } catch (error) {
        if (this.hasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) total += await this.measureDirectory(child);
      else if (details.isFile()) total += BigInt(details.size);
    }
    return total;
  }

  private hasCode(error: unknown, code: string) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code
    );
  }
}
