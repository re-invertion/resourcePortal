import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

type ProvisionVolume = {
  dockerVolumeName: string;
  storagePath: string;
};

type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ProvisionResult = {
  success: boolean;
  message: string;
  details: string;
};

@Injectable()
export class StackVolumeProvisionerService {
  constructor(private readonly config: ConfigService) {}

  async provisionVolumes(volumes: ProvisionVolume[]): Promise<ProvisionResult> {
    const uniqueVolumes = this.uniqueVolumes(volumes);
    const details: string[] = [];

    for (const volume of uniqueVolumes) {
      await mkdir(volume.storagePath, { recursive: true });
      details.push(`Created storage path ${volume.storagePath}`);

      const inspect = await this.runDocker([
        "volume",
        "inspect",
        volume.dockerVolumeName,
      ]);

      if (inspect.exitCode === 0) {
        details.push(`Docker volume ${volume.dockerVolumeName} already exists`);
        continue;
      }

      const create = await this.runDocker([
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=none",
        "--opt",
        "o=bind",
        "--opt",
        `device=${volume.storagePath}`,
        volume.dockerVolumeName,
      ]);

      if (create.exitCode !== 0) {
        return {
          success: false,
          message: `Docker volume create failed for ${volume.dockerVolumeName}`,
          details: [
            ...details,
            create.command,
            create.stderr || create.stdout || `Exit code ${create.exitCode}`,
          ].join("\n"),
        };
      }

      details.push(`Created Docker volume ${volume.dockerVolumeName}`);
    }

    return {
      success: true,
      message: `Provisioned ${uniqueVolumes.length} volume(s)`,
      details: details.join("\n"),
    };
  }

  private uniqueVolumes(volumes: ProvisionVolume[]) {
    return Array.from(
      new Map(volumes.map((volume) => [volume.dockerVolumeName, volume]))
        .values(),
    );
  }

  private runDocker(args: string[]) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_VOLUME_PROVISION_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [...(dockerContext ? ["--context", dockerContext] : []), ...args];
    const command = `docker ${fullArgs.join(" ")}`;

    return new Promise<CommandResult>((resolve) => {
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
        resolve({
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
        resolve({
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
