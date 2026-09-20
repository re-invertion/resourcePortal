import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { deploymentArtifactMatches } from "./deployment-artifact";
import { inspectAppGroupNetworkTopology } from "./app-group-networking";
import {
  appGroupNetworkName,
  legacyAppGroupIngressNetworkName,
} from "./traefik-routing";
import { StackRuntimeService } from "./stack-runtime.service";

type ApplyResult = {
  command: string;
  stackName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class StackApplyService {
  constructor(
    private readonly config: ConfigService,
    private readonly runtime: StackRuntimeService,
  ) {}

  async applyStack(params: {
    stackName: string;
    renderedStack: string;
    artifactSha256: string;
    appGroupId: string;
  }): Promise<ApplyResult> {
    if (
      !deploymentArtifactMatches(params.renderedStack, params.artifactSha256)
    ) {
      return {
        command: "verify deployment artifact sha256",
        stackName: params.stackName,
        exitCode: 2,
        stdout: "",
        stderr:
          "Rendered deployment artifact SHA-256 does not match persisted digest",
      };
    }

    const appGroupNetwork = appGroupNetworkName(params.appGroupId);
    const legacyIngressNetwork = legacyAppGroupIngressNetworkName(
      params.appGroupId,
    );
    let topology;
    try {
      topology = inspectAppGroupNetworkTopology(
        params.renderedStack,
        appGroupNetwork,
        legacyIngressNetwork,
      );
    } catch (error) {
      return {
        command: "parse rendered stack network topology",
        stackName: params.stackName,
        exitCode: 2,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }

    const prepared =
      topology.mode === "single"
        ? await this.runtime.reconcileAppGroupNetwork({
            networkName: appGroupNetwork,
            traefikRequired: topology.traefikRequired,
          })
        : await this.runtime.reconcileLegacyIngressNetwork({
            networkName: legacyIngressNetwork,
            required: topology.traefikRequired,
          });
    if (!prepared.success) {
      return {
        command: `prepare ${topology.mode} App Group network`,
        stackName: params.stackName,
        exitCode: 1,
        stdout: "",
        stderr:
          "error" in prepared && typeof prepared.error === "string"
            ? prepared.error
            : "Failed to prepare App Group network topology",
      };
    }

    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const args = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      "stack",
      "deploy",
      "--detach=true",
      "--with-registry-auth",
      "-c",
      "-",
      params.stackName,
    ];
    const result = await this.run("docker", args, params.renderedStack);

    if (result.exitCode === 0 && topology.mode === "single") {
      // v0.2 single-network deployment has already removed the legacy network
      // from tenant services. Detach Traefik and delete the obsolete overlay.
      // Cleanup is best effort and is retried by IngressReconcilerService.
      await this.runtime
        .reconcileLegacyIngressNetwork({
          networkName: legacyIngressNetwork,
          required: false,
        })
        .catch(() => undefined);
    }

    return { ...result, stackName: params.stackName };
  }

  private run(
    command: string,
    args: string[],
    stdin?: string,
  ): Promise<CommandResult> {
    const timeoutMs = this.config.get<number>(
      "DOCKER_APPLY_TIMEOUT_MS",
      120000,
    );
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const renderedCommand = `${command} ${args.join(" ")}`;
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const finishFromExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        finish({
          command: renderedCommand,
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal
            ? `${renderedCommand} terminated by ${signal}`
            : this.decode(stderr),
        });
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish({
          command: renderedCommand,
          exitCode: 124,
          stdout: this.decode(stdout),
          stderr: `${renderedCommand} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        finish({
          command: renderedCommand,
          exitCode: 127,
          stdout: this.decode(stdout),
          stderr: error.message,
        });
      });
      child.on("exit", finishFromExit);
      child.on("close", finishFromExit);
      child.stdin.end(stdin);
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
