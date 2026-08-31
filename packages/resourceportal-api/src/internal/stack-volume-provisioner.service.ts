import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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
    const server = this.config.get<string>("NFS_GANESHA_SERVER", "").trim();

    if (!server) {
      return {
        success: false,
        message: "NFS-Ganesha server is not configured",
        details: "NFS_GANESHA_SERVER is required for CephFS Volume provisioning",
      };
    }

    const nodes = await this.runDocker([
      "node",
      "ls",
      "--filter",
      "status=ready",
      "--format",
      "{{.ID}}",
    ]);
    if (nodes.exitCode !== 0) {
      return {
        success: false,
        message: "Unable to enumerate Ready Swarm nodes",
        details: nodes.stderr || nodes.stdout || nodes.command,
      };
    }
    const nodeCount = nodes.stdout.split("\n").filter(Boolean).length;
    if (nodeCount === 0) {
      return {
        success: false,
        message: "No Ready Swarm nodes for Volume provisioning",
        details: nodes.command,
      };
    }

    for (const volume of uniqueVolumes) {
      const result = await this.provisionVolumeOnAllNodes(volume, nodeCount);
      details.push(result.details);
      if (!result.success) {
        return {
          success: false,
          message: result.message,
          details: details.join("\n"),
        };
      }
    }

    return {
      success: true,
      message: `Provisioned ${uniqueVolumes.length} NFS volume(s) on ${nodeCount} Ready node(s)`,
      details: details.join("\n"),
    };
  }

  private async provisionVolumeOnAllNodes(
    volume: ProvisionVolume,
    nodeCount: number,
  ): Promise<ProvisionResult> {
    const serviceName = `rp-vol-provision-${randomUUID().slice(0, 8)}`;
    const server = this.config.get<string>("NFS_GANESHA_SERVER", "").trim();
    const version = this.config.get<string>("NFS_GANESHA_VERSION", "4.1");
    const image = this.config.get<string>(
      "STORAGE_REMOTE_VALIDATION_IMAGE",
      "alpine:3.20",
    );
    const mount = [
      "type=volume",
      `source=${volume.dockerVolumeName}`,
      "target=/probe",
      "volume-driver=local",
      "volume-opt=type=nfs",
      `volume-opt=o=addr=${server}\\,nfsvers=${version}\\,rw`,
      `volume-opt=device=:${volume.storagePath}`,
    ].join(",");
    const create = await this.runDocker([
      "service",
      "create",
      "--detach",
      "--name",
      serviceName,
      "--mode",
      "global",
      "--restart-condition",
      "none",
      "--mount",
      mount,
      image,
      "sh",
      "-c",
      'probe="/probe/.rp-volume-provision-$HOSTNAME"; printf ok > "$probe" && test "$(cat "$probe")" = ok && rm -f "$probe"',
    ]);

    if (create.exitCode !== 0) {
      return {
        success: false,
        message: `NFS volume provision failed for ${volume.dockerVolumeName}`,
        details: create.stderr || create.stdout || create.command,
      };
    }

    try {
      const completion = await this.waitForGlobalCompletion(serviceName, nodeCount);
      if (!completion.success) {
        return {
          success: false,
          message: `NFS volume provision failed for ${volume.dockerVolumeName}`,
          details: completion.details,
        };
      }
      return {
        success: true,
        message: `Provisioned ${volume.dockerVolumeName}`,
        details: `Validated ${volume.storagePath} through NFS-Ganesha on ${nodeCount} Ready node(s)`,
      };
    } finally {
      await this.runDocker(["service", "rm", serviceName]).catch(() => undefined);
    }
  }

  private async waitForGlobalCompletion(serviceName: string, nodeCount: number) {
    const timeoutMs = this.config.get<number>(
      "DOCKER_VOLUME_PROVISION_TIMEOUT_MS",
      120000,
    );
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.runDocker([
        "service",
        "ps",
        "--no-trunc",
        "--format",
        "{{.CurrentState}}|{{.Error}}",
        serviceName,
      ]);
      if (status.exitCode !== 0) {
        return {
          success: false,
          details: status.stderr || status.stdout || status.command,
        };
      }
      const tasks = status.stdout.split("\n").filter(Boolean);
      const failed = tasks.find((line) => /^(Failed|Rejected)/i.test(line));
      if (failed) {
        return { success: false, details: failed };
      }
      const completed = tasks.filter((line) => /^Complete/i.test(line)).length;
      if (completed >= nodeCount) {
        return { success: true, details: status.stdout };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { success: false, details: "Timed out waiting for NFS volume provisioning" };
  }

  private uniqueVolumes(volumes: ProvisionVolume[]) {
    return Array.from(
      new Map(volumes.map((volume) => [volume.dockerVolumeName, volume])).values(),
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
        if (settled) return;
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
