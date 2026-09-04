import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HealthState } from "@prisma/client";
import { statfs } from "node:fs/promises";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

export type LocalStorageFilesystem = "xfs" | "ext4";

@Injectable()
export class LocalFilesystemStorageAdapterService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validateLocal() {
    const mountRoot = this.config.get<string>(
      "STORAGE_MOUNT_ROOT",
      "/mnt/resourceportal-storage",
    );
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

  private isSupportedFilesystem(value: string): value is LocalStorageFilesystem {
    return value === "xfs" || value === "ext4";
  }
}
