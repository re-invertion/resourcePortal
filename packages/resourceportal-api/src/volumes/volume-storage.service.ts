import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type DeleteVolumeDataInput = {
  tenantId: string;
  volumeId: string;
  storagePath: string;
  dockerVolumeName: string;
};

type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class VolumeStorageService {
  constructor(private readonly config: ConfigService) {}

  async measureUsedSize(storagePath: string): Promise<bigint> {
    return this.measureDirectory(storagePath);
  }

  async deleteVolumeData(input: DeleteVolumeDataInput): Promise<void> {
    this.assertSafeStoragePath(input);

    const inspect = await this.runDocker([
      "volume",
      "inspect",
      input.dockerVolumeName,
    ]);

    if (inspect.exitCode === 0) {
      const remove = await this.runDocker([
        "volume",
        "rm",
        input.dockerVolumeName,
      ]);

      if (remove.exitCode !== 0) {
        if (this.isVolumeInUse(remove)) {
          throw new ConflictException("Volume runtime is still in use");
        }

        throw new InternalServerErrorException(
          `Docker volume remove failed for ${input.dockerVolumeName}`,
        );
      }
    } else if (!this.isMissingVolume(inspect)) {
      throw new InternalServerErrorException(
        `Docker volume inspect failed for ${input.dockerVolumeName}`,
      );
    }

    await rm(input.storagePath, { recursive: true, force: true });
  }

  private async measureDirectory(storagePath: string): Promise<bigint> {
    let entries: string[];

    try {
      entries = await readdir(storagePath);
    } catch (error) {
      if (this.hasErrorCode(error, "ENOENT")) {
        return 0n;
      }
      throw error;
    }

    let total = 0n;

    for (const entry of entries) {
      const entryPath = join(storagePath, entry);
      let details;

      try {
        details = await lstat(entryPath);
      } catch (error) {
        if (this.hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      if (details.isSymbolicLink()) {
        continue;
      }

      if (details.isDirectory()) {
        total += await this.measureDirectory(entryPath);
        continue;
      }

      if (details.isFile()) {
        total += BigInt(details.size);
      }
    }

    return total;
  }

  private assertSafeStoragePath(input: DeleteVolumeDataInput) {
    const storageRoot = this.config.get<string>(
      "RESOURCE_STORAGE_ROOT",
      "/rp/volumes",
    );
    const expected = resolve(storageRoot, input.tenantId, input.volumeId);
    const actual = resolve(input.storagePath);

    if (actual !== expected) {
      throw new InternalServerErrorException("Unsafe volume storage path");
    }
  }

  private isMissingVolume(result: CommandResult) {
    return this.commandOutput(result).includes("no such volume");
  }

  private isVolumeInUse(result: CommandResult) {
    return this.commandOutput(result).includes("volume is in use");
  }

  private commandOutput(result: CommandResult) {
    return `${result.stderr}\n${result.stdout}`.toLowerCase();
  }

  private hasErrorCode(error: unknown, code: string) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code
    );
  }

  private runDocker(args: string[]) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_VOLUME_PROVISION_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      ...args,
    ];
    const command = `docker ${fullArgs.join(" ")}`;

    return new Promise<CommandResult>((resolveCommand) => {
      const child = spawn("docker", fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
        }
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        settled = true;
        clearTimeout(timeout);
        resolveCommand({
          command,
          exitCode: 127,
          stdout: this.decode(stdout),
          stderr: error.message,
        });
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolveCommand({
          command,
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal
            ? `docker volume command terminated by ${signal}`
            : this.decode(stderr),
        });
      });
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
