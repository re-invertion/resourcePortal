import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEFAULT_VOLUME_RUNTIME_ROOT } from "../storage-backends/storage-paths";

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

export type StorageNodeReadiness = {
  id: string;
  ready: boolean;
  volumesReady: boolean;
};

export function parseStorageNode(line: string): StorageNodeReadiness {
  const [id = "", status = "", volumesLabel = ""] = line.split("|");
  return {
    id: id.trim(),
    ready: status.trim().toLowerCase() === "ready",
    volumesReady: volumesLabel.trim().toLowerCase() === "true",
  };
}

@Injectable()
export class StackVolumeProvisionerService {
  constructor(private readonly config: ConfigService) {}

  async provisionVolumes(volumes: ProvisionVolume[]): Promise<ProvisionResult> {
    if (volumes.length === 0) {
      return {
        success: true,
        message: "No Volume runtime readiness validation required",
        details: "",
      };
    }

    const nodes = await this.runDocker([
      "node",
      "ls",
      "--format",
      "{{.ID}}|{{.Status}}",
    ]);
    if (nodes.exitCode !== 0) {
      return {
        success: false,
        message: "Unable to enumerate Swarm nodes",
        details: nodes.stderr || nodes.stdout || nodes.command,
      };
    }

    const eligibleNodes: StorageNodeReadiness[] = [];
    for (const line of nodes.stdout.split("\n").filter(Boolean)) {
      const [id = "", status = ""] = line.split("|");
      if (status.trim().toLowerCase() !== "ready") continue;
      const label = await this.runDocker([
        "node",
        "inspect",
        "--format",
        '{{index .Spec.Labels "resourceportal.storage.volumes"}}',
        id.trim(),
      ]);
      if (label.exitCode !== 0) {
        return {
          success: false,
          message: "Unable to inspect Swarm storage readiness",
          details: label.stderr || label.stdout || label.command,
        };
      }
      const node = parseStorageNode(`${id}|${status}|${label.stdout.trim()}`);
      if (node.ready && node.volumesReady) eligibleNodes.push(node);
    }

    if (eligibleNodes.length === 0) {
      return {
        success: false,
        message: "No Ready Swarm nodes with Volume storage readiness",
        details: nodes.command,
      };
    }

    const serviceName = `rp-volume-runtime-probe-${randomUUID().slice(0, 8)}`;
    const runtimeRoot = this.config.get<string>(
      "RESOURCE_VOLUME_RUNTIME_ROOT",
      DEFAULT_VOLUME_RUNTIME_ROOT,
    );
    const image = this.config.get<string>(
      "STORAGE_REMOTE_VALIDATION_IMAGE",
      "alpine:3.20",
    );
    const create = await this.runDocker([
      "service",
      "create",
      "--detach",
      "--name",
      serviceName,
      "--mode",
      "global",
      "--constraint",
      "node.labels.resourceportal.storage.volumes==true",
      "--restart-condition",
      "none",
      "--mount",
      `type=bind,source=${runtimeRoot},target=/probe`,
      image,
      "sh",
      "-c",
      'probe="/probe/.rp-volume-runtime-probe-$HOSTNAME"; printf ok > "$probe" && test "$(cat "$probe")" = ok && rm -f "$probe"',
    ]);

    if (create.exitCode !== 0) {
      return {
        success: false,
        message: "Volume runtime namespace probe could not start",
        details: create.stderr || create.stdout || create.command,
      };
    }

    try {
      const completion = await this.waitForGlobalCompletion(
        serviceName,
        eligibleNodes.length,
      );
      if (!completion.success) {
        return {
          success: false,
          message: "Volume runtime namespace readiness validation failed",
          details: completion.details,
        };
      }
      return {
        success: true,
        message: `Validated canonical Volume runtime namespace on ${eligibleNodes.length} Ready storage node(s)`,
        details: `${runtimeRoot} is writable on eligible nodes`,
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
      if (failed) return { success: false, details: failed };
      const completed = tasks.filter((line) => /^Complete/i.test(line)).length;
      if (completed >= nodeCount) {
        return { success: true, details: status.stdout };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      success: false,
      details: "Timed out waiting for Volume runtime namespace readiness probe",
    };
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
        if (!settled) child.kill("SIGTERM");
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
            ? `docker storage readiness command terminated by ${signal}`
            : this.decode(stderr),
        });
      });
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
