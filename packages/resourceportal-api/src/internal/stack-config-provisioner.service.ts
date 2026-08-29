import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

type ProvisionConfig = {
  dockerConfigName: string;
  content: string;
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
export class StackConfigProvisionerService {
  constructor(private readonly config: ConfigService) {}

  async provisionConfigs(configs: ProvisionConfig[]): Promise<ProvisionResult> {
    const uniqueConfigs = this.uniqueConfigs(configs);
    const details: string[] = [];

    for (const config of uniqueConfigs) {
      const inspect = await this.runDocker([
        "config",
        "inspect",
        config.dockerConfigName,
      ]);

      if (inspect.exitCode === 0) {
        details.push(`Docker config ${config.dockerConfigName} already exists`);
        continue;
      }

      const create = await this.runDocker(
        ["config", "create", config.dockerConfigName, "-"],
        config.content,
      );

      if (create.exitCode !== 0) {
        return {
          success: false,
          message: `Docker config create failed for ${config.dockerConfigName}`,
          details: [
            ...details,
            create.command,
            create.stderr || create.stdout || `Exit code ${create.exitCode}`,
          ].join("\n"),
        };
      }

      details.push(`Created Docker config ${config.dockerConfigName}`);
    }

    return {
      success: true,
      message: `Provisioned ${uniqueConfigs.length} config(s)`,
      details: details.join("\n"),
    };
  }

  private uniqueConfigs(configs: ProvisionConfig[]) {
    return Array.from(
      new Map(configs.map((config) => [config.dockerConfigName, config])).values(),
    );
  }

  private runDocker(args: string[], stdin?: string) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_CONFIG_PROVISION_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [...(dockerContext ? ["--context", dockerContext] : []), ...args];
    const command = `docker ${fullArgs.join(" ")}`;

    return new Promise<CommandResult>((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
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
            ? `docker config command terminated by ${signal}`
            : this.decode(stderr),
        });
      });

      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
