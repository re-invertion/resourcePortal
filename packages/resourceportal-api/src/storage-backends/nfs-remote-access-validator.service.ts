import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { DEFAULT_VOLUME_RUNTIME_ROOT } from "./storage-paths";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

export type NfsRemoteValidationResult = {
  ok: boolean;
  skipped: boolean;
  error: string | null;
};

type StorageNode = {
  ready: boolean;
  volumesReady: boolean;
};

@Injectable()
export class NfsRemoteAccessValidatorService {
  constructor(
    private readonly config: ConfigService,
    private readonly commands: StorageCommandRunnerService,
  ) {}

  async validate(basePath: string): Promise<NfsRemoteValidationResult> {
    void basePath;
    if (!this.enabled()) {
      return {
        ok: true,
        skipped: true,
        error: "Remote storage validation disabled by configuration",
      };
    }

    const nodes = await this.docker([
      "node",
      "ls",
      "--format",
      "{{.ID}}|{{.Status}}",
    ]);
    if (nodes.exitCode !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `Unable to list Swarm nodes: ${nodes.stderr || nodes.stdout}`,
      };
    }

    let eligibleNodeCount = 0;
    for (const line of nodes.stdout.split("\n").filter(Boolean)) {
      const [id = "", status = ""] = line.split("|");
      if (status.trim().toLowerCase() !== "ready") continue;
      const label = await this.docker([
        "node",
        "inspect",
        "--format",
        '{{index .Spec.Labels "resourceportal.storage.volumes"}}',
        id.trim(),
      ]);
      if (label.exitCode !== 0) {
        return {
          ok: false,
          skipped: false,
          error: `Unable to inspect Swarm storage readiness: ${label.stderr || label.stdout}`,
        };
      }
      const node = this.parseNode(`${id}|${status}|${label.stdout.trim()}`);
      if (node.ready && node.volumesReady) eligibleNodeCount += 1;
    }
    if (eligibleNodeCount === 0) {
      return {
        ok: false,
        skipped: false,
        error: "No Ready Swarm RemoteLocations with Volume storage readiness",
      };
    }

    const serviceName = `rp-storage-runtime-probe-${randomUUID().slice(0, 8)}`;
    const image = this.config.get<string>(
      "STORAGE_REMOTE_VALIDATION_IMAGE",
      "alpine:3.20",
    );
    const runtimeRoot = this.config.get<string>(
      "RESOURCE_VOLUME_RUNTIME_ROOT",
      DEFAULT_VOLUME_RUNTIME_ROOT,
    );
    const create = await this.docker([
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
      'probe="/probe/.rp-storage-runtime-probe-$HOSTNAME"; printf ok > "$probe" && test "$(cat "$probe")" = ok && rm -f "$probe"',
    ]);
    if (create.exitCode !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `storage runtime probe service create failed: ${create.stderr || create.stdout}`,
      };
    }

    try {
      return await this.waitForProbe(serviceName, eligibleNodeCount);
    } finally {
      await this.docker(["service", "rm", serviceName]).catch(() => undefined);
    }
  }

  private async waitForProbe(
    serviceName: string,
    nodeCount: number,
  ): Promise<NfsRemoteValidationResult> {
    const timeoutMs = this.config.get<number>(
      "STORAGE_REMOTE_VALIDATION_TIMEOUT_MS",
      120000,
    );
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
          error: `storage runtime probe inspection failed: ${result.stderr || result.stdout}`,
        };
      }

      const tasks = result.stdout.split("\n").filter(Boolean);
      const failed = tasks.find((line) => /^(Failed|Rejected)/i.test(line));
      if (failed) {
        return {
          ok: false,
          skipped: false,
          error: `storage runtime probe failed: ${failed}`,
        };
      }
      const completed = tasks.filter((line) => /^Complete/i.test(line)).length;
      if (completed >= nodeCount) {
        return { ok: true, skipped: false, error: null };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      ok: false,
      skipped: false,
      error: "storage runtime probe timed out",
    };
  }

  private parseNode(line: string): StorageNode {
    const [, status = "", volumesLabel = ""] = line.split("|");
    return {
      ready: status.trim().toLowerCase() === "ready",
      volumesReady: volumesLabel.trim().toLowerCase() === "true",
    };
  }

  private enabled() {
    return (
      this.config.get<string>("STORAGE_REMOTE_VALIDATION_ENABLED", "true") !==
      "false"
    );
  }

  private docker(args: string[]) {
    const context = this.config.get<string>("DOCKER_CONTEXT");
    return this.commands.run("docker", [
      ...(context ? ["--context", context] : []),
      ...args,
    ]);
  }
}
