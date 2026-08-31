import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

export type NfsRemoteValidationResult = {
  ok: boolean;
  skipped: boolean;
  error: string | null;
};

@Injectable()
export class NfsRemoteAccessValidatorService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validate(basePath: string): Promise<NfsRemoteValidationResult> {
    if (!this.enabled()) {
      return {
        ok: true,
        skipped: true,
        error: "Remote NFS validation disabled by configuration",
      };
    }

    const server = this.config.get<string>("NFS_GANESHA_SERVER", "").trim();
    if (!server) {
      return { ok: false, skipped: false, error: "NFS_GANESHA_SERVER is required" };
    }

    const readyNodes = await this.docker([
      "node",
      "ls",
      "--filter",
      "status=ready",
      "--format",
      "{{.ID}}",
    ]);
    if (readyNodes.exitCode !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `Unable to list Ready Swarm nodes: ${readyNodes.stderr || readyNodes.stdout}`,
      };
    }
    const nodeCount = readyNodes.stdout.split("\n").filter(Boolean).length;
    if (nodeCount === 0) {
      return { ok: false, skipped: false, error: "No Ready Swarm RemoteLocations" };
    }

    const serviceName = `rp-storage-probe-${randomUUID().slice(0, 8)}`;
    const version = this.config.get<string>("NFS_GANESHA_VERSION", "4.1");
    const image = this.config.get<string>("STORAGE_REMOTE_VALIDATION_IMAGE", "alpine:3.20");
    const mount = [
      "type=volume",
      "target=/probe",
      "volume-driver=local",
      "volume-opt=type=nfs",
      `volume-opt=o=addr=${server}\\,nfsvers=${version}\\,rw`,
      `volume-opt=device=:${basePath}`,
    ].join(",");
    const create = await this.docker([
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
      'probe="/probe/.rp-storage-probe-$HOSTNAME"; printf ok > "$probe" && test "$(cat "$probe")" = ok && rm -f "$probe"',
    ]);
    if (create.exitCode !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `NFS probe service create failed: ${create.stderr || create.stdout}`,
      };
    }

    try {
      return await this.waitForProbe(serviceName, nodeCount);
    } finally {
      await this.docker(["service", "rm", serviceName]).catch(() => undefined);
    }
  }

  private async waitForProbe(
    serviceName: string,
    nodeCount: number,
  ): Promise<NfsRemoteValidationResult> {
    const timeoutMs = this.config.get<number>("STORAGE_REMOTE_VALIDATION_TIMEOUT_MS", 120000);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.docker([
        "service",
        "ps",
        "--no-trunc",
        "--format",
        "{{.CurrentState}}|{{.Error}}",
        serviceName,
      ]);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          skipped: false,
          error: `NFS probe inspection failed: ${result.stderr || result.stdout}`,
        };
      }

      const tasks = result.stdout.split("\n").filter(Boolean);
      const failed = tasks.find((line) => /^(Failed|Rejected)/i.test(line));
      if (failed) {
        return { ok: false, skipped: false, error: `NFS probe failed: ${failed}` };
      }
      const completed = tasks.filter((line) => /^Complete/i.test(line)).length;
      if (completed >= nodeCount) {
        return { ok: true, skipped: false, error: null };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { ok: false, skipped: false, error: "NFS probe timed out" };
  }

  private enabled() {
    return this.config.get<string>("STORAGE_REMOTE_VALIDATION_ENABLED", "true") !== "false";
  }

  private docker(args: string[]) {
    const context = this.config.get<string>("DOCKER_CONTEXT");
    return this.commands.run("docker", [
      ...(context ? ["--context", context] : []),
      ...args,
    ]);
  }
}
