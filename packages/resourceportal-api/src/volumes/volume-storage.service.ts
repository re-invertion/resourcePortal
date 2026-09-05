import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_STORAGE_BASE_PATH,
  physicalVolumePath,
} from "../storage-backends/storage-paths";

type DeleteVolumeDataInput = {
  tenantId: string;
  volumeId: string;
  storagePath: string;
};

@Injectable()
export class VolumeStorageService {
  constructor(private readonly config: ConfigService) {}

  async measureUsedSize(storagePath: string): Promise<bigint> {
    return this.measureDirectory(storagePath);
  }

  async deleteVolumeData(input: DeleteVolumeDataInput): Promise<void> {
    this.assertSafeStoragePath(input);
    await rm(input.storagePath, { recursive: true, force: true });
  }

  private async measureDirectory(storagePath: string): Promise<bigint> {
    let entries: string[];

    try {
      entries = await readdir(storagePath);
    } catch (error) {
      if (this.hasErrorCode(error, "ENOENT")) return 0n;
      throw error;
    }

    let total = 0n;
    for (const entry of entries) {
      const entryPath = join(storagePath, entry);
      let details;
      try {
        details = await lstat(entryPath);
      } catch (error) {
        if (this.hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) total += await this.measureDirectory(entryPath);
      else if (details.isFile()) total += BigInt(details.size);
    }
    return total;
  }

  private assertSafeStoragePath(input: DeleteVolumeDataInput) {
    const basePath = this.config.get<string>(
      "RESOURCE_STORAGE_BASE_PATH",
      DEFAULT_STORAGE_BASE_PATH,
    );
    const expected = physicalVolumePath(basePath, input.tenantId, input.volumeId);
    const actual = resolve(input.storagePath);
    if (actual !== expected) {
      throw new InternalServerErrorException("Unsafe volume storage path");
    }
  }

  private hasErrorCode(error: unknown, code: string) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code
    );
  }
}
