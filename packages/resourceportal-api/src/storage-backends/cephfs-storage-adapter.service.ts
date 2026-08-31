import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { posix } from "node:path";
import {
  buildNfsDriverOptions,
  cephHealthToState,
  parseCephCapacity,
  resolveCephFsLocalPath,
} from "./storage-backend.logic";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

export type CephFsBackendDescriptor = {
  id: string;
  basePath: string;
  volumeBasePath: string;
  secretBasePath: string;
};

@Injectable()
export class CephFsStorageAdapterService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validateLocal() {
    const ceph = this.config.get<string>("CEPH_CLI", "ceph");
    const healthResult = await this.commands.run(ceph, ["health", "--format", "json"]);
    if (healthResult.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Ceph health check failed: ${healthResult.stderr || healthResult.stdout}`,
      );
    }
    const healthPayload = JSON.parse(healthResult.stdout) as { status?: string };
    const health = cephHealthToState(healthPayload.status ?? "");

    const capacityResult = await this.commands.run(ceph, ["df", "--format", "json"]);
    if (capacityResult.exitCode !== 0) {
      throw new InternalServerErrorException(
        `Ceph capacity check failed: ${capacityResult.stderr || capacityResult.stdout}`,
      );
    }
    const capacity = parseCephCapacity(capacityResult.stdout);

    return {
      health,
      capacityTotal: capacity.totalBytes,
      capacityAvailable: capacity.availableBytes,
    };
  }

  async provisionVolume(
    backend: CephFsBackendDescriptor,
    input: { tenantId: string; volumeId: string; sizeBytes: bigint },
  ) {
    const storagePath = posix.join(
      backend.volumeBasePath,
      input.tenantId,
      input.volumeId,
    );
    const localPath = this.localPath(backend, storagePath);
    await mkdir(localPath, { recursive: true });

    try {
      await this.applyAndVerifyQuota(localPath, input.sizeBytes);
    } catch (error) {
      await rm(localPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return { storagePath };
  }

  async resizeVolume(
    backend: CephFsBackendDescriptor,
    storagePath: string,
    sizeBytes: bigint,
  ) {
    await this.applyAndVerifyQuota(this.localPath(backend, storagePath), sizeBytes);
  }

  async deleteVolume(backend: CephFsBackendDescriptor, storagePath: string) {
    await rm(this.localPath(backend, storagePath), { recursive: true, force: true });
  }

  async measureUsedSize(backend: CephFsBackendDescriptor, storagePath: string) {
    return this.measureDirectory(this.localPath(backend, storagePath));
  }

  runtimeDriverOptions(storagePath: string) {
    return buildNfsDriverOptions(
      this.config.get<string>("NFS_GANESHA_SERVER", ""),
      this.config.get<string>("NFS_GANESHA_VERSION", "4.1"),
      storagePath,
    );
  }

  private localPath(backend: CephFsBackendDescriptor, logicalPath: string) {
    return resolveCephFsLocalPath(
      this.config.get<string>("CEPHFS_MOUNT_ROOT", "/"),
      backend.basePath,
      logicalPath,
    );
  }

  private async applyAndVerifyQuota(localPath: string, sizeBytes: bigint) {
    const setCli = this.config.get<string>("CEPHFS_SETXATTR_CLI", "setfattr");
    const getCli = this.config.get<string>("CEPHFS_GETXATTR_CLI", "getfattr");
    const expected = sizeBytes.toString();
    const setResult = await this.commands.run(setCli, [
      "-n",
      "ceph.quota.max_bytes",
      "-v",
      expected,
      localPath,
    ]);
    if (setResult.exitCode !== 0) {
      throw new InternalServerErrorException(
        `CephFS quota update failed: ${setResult.stderr || setResult.stdout}`,
      );
    }

    const getResult = await this.commands.run(getCli, [
      "--only-values",
      "-n",
      "ceph.quota.max_bytes",
      localPath,
    ]);
    if (getResult.exitCode !== 0 || getResult.stdout.trim() !== expected) {
      throw new InternalServerErrorException(
        `CephFS quota verification failed: expected ${expected}, got ${getResult.stdout.trim() || "unavailable"}`,
      );
    }
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
