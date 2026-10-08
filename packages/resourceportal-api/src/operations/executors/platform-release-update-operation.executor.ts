import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StorageCommandRunnerService } from "../../storage-backends/storage-command-runner.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

type UpdateInput = {
  targetVersion?: unknown;
  manifestUrl?: unknown;
};

@Injectable()
export class PlatformReleaseUpdateOperationExecutor implements OperationExecutor {
  readonly types = ["PLATFORM_RELEASE_UPDATE"] as const satisfies readonly OperationType[];

  constructor(
    private readonly runner: StorageCommandRunnerService,
    private readonly config: ConfigService,
  ) {}

  async execute(operation: OperationRecord) {
    const input = this.input(operation);
    const targetVersion = this.version(input.targetVersion);
    const currentVersion =
      this.config.get<string>("INSTALLER_VERSION")?.trim() ||
      this.config.get<string>("RESOURCEPORTAL_VERSION")?.trim();
    if (currentVersion === targetVersion) {
      return {
        resourceId: targetVersion,
        result: { targetVersion, currentVersion, status: "already-current" },
      };
    }

    const manifestUrl = this.manifestUrl(input.manifestUrl, targetVersion);
    const name = `resourceportal-updater-${operation.id}`;
    const existing = await this.inspect(name);
    if (!existing) {
      await this.startUpdater(name, targetVersion, manifestUrl);
    } else if (existing.status === "exited" && existing.exitCode !== 0) {
      const logs = await this.runner.run("docker", ["logs", "--tail", "200", name]);
      throw Object.assign(
        new Error(logs.stderr || logs.stdout || `Updater container exited with code ${existing.exitCode}`),
        { code: "PlatformUpdateFailed", retryable: false },
      );
    }

    const waited = await this.runner.run(
      "docker",
      ["wait", name],
      30 * 60 * 1000,
    );
    if (waited.exitCode === 124) {
      throw Object.assign(new Error("Platform updater is still running"), {
        code: "PlatformUpdateInProgress",
        retryable: true,
      });
    }
    const updaterExit = Number.parseInt(waited.stdout.trim(), 10);
    if (waited.exitCode !== 0 || updaterExit !== 0) {
      const logs = await this.runner.run("docker", ["logs", "--tail", "200", name]);
      throw Object.assign(
        new Error(logs.stderr || logs.stdout || "Platform updater failed"),
        { code: "PlatformUpdateFailed", retryable: false },
      );
    }

    return {
      resourceId: targetVersion,
      result: {
        targetVersion,
        status: "updater-completed",
        note:
          "The control plane may reconnect on the target image before this operation result is observed.",
      },
    };
  }

  private async startUpdater(
    name: string,
    targetVersion: string,
    manifestUrl: string,
  ) {
    const image = this.required("RESOURCEPORTAL_RUNTIME_IMAGE");
    const storageBase = this.required("RESOURCE_STORAGE_BASE_PATH");
    const storageDevice = this.required("RESOURCE_STORAGE_QUOTA_DEVICE");
    const script = [
      "set -euo pipefail",
      "manifest=/tmp/resourceportal-release-manifest.json",
      'curl --fail --silent --show-error --location --proto "=https" "${RP_TARGET_MANIFEST_URL}" -o "$manifest"',
      "export RP_NON_INTERACTIVE=true RP_UI_MODE=text RP_UPGRADE_SKIP_HOST_FIREWALL=true",
      'exec /bin/bash /app/resourceportal-installer/resourceportal-install.sh --mode upgrade --manifest "$manifest" --non-interactive',
    ].join("\n");

    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--user",
      "0",
      "--network",
      "host",
      "--label",
      "resourceportal.updater=true",
      "--label",
      `resourceportal.target-version=${targetVersion}`,
      "-e",
      `RP_TARGET_VERSION=${targetVersion}`,
      "-e",
      `RP_TARGET_MANIFEST_URL=${manifestUrl}`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      "/etc/resourceportal:/etc/resourceportal",
      "-v",
      "/var/lib/resourceportal:/var/lib/resourceportal",
      "-v",
      `${storageBase}:${storageBase}`,
      "-v",
      "/mnt/resourceportal/platform:/mnt/resourceportal/platform",
      "--device",
      `${storageDevice}:${storageDevice}`,
    ];
    args.push(image, "/bin/bash", "-lc", script);

    const started = await this.runner.run("docker", args, 120000);
    if (started.exitCode !== 0) {
      throw Object.assign(
        new Error(started.stderr || "Unable to start platform updater container"),
        { code: "PlatformUpdaterStartFailed", retryable: true },
      );
    }
  }

  private async inspect(name: string) {
    const result = await this.runner.run("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}}",
      name,
    ]);
    if (result.exitCode !== 0) return null;
    const [status, code] = result.stdout.trim().split(/\s+/, 2);
    return {
      status,
      exitCode: Number.parseInt(code ?? "0", 10),
    };
  }

  private input(operation: OperationRecord): UpdateInput {
    if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
      throw new Error("InvalidOperationInput");
    }
    return operation.input as UpdateInput;
  }

  private version(value: unknown) {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error("InvalidOperationInput:targetVersion");
    }
    return value;
  }

  private manifestUrl(value: unknown, version: string) {
    if (typeof value !== "string") throw new Error("InvalidOperationInput:manifestUrl");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.includes(`/releases/download/v${version}/resourceportal-release-manifest.json`)
    ) {
      throw new Error("InvalidOperationInput:manifestUrl");
    }
    return url.toString();
  }

  private required(key: string) {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new Error(`Missing platform updater configuration: ${key}`);
    return value;
  }
}
