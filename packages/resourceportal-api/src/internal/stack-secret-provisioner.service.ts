import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

type ProvisionSecret = {
  dockerSecretName: string;
  value: string | Buffer;
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
export class StackSecretProvisionerService {
  constructor(private readonly config: ConfigService) {}

  async provisionSecrets(secrets: ProvisionSecret[]): Promise<ProvisionResult> {
    const uniqueSecrets = this.uniqueSecrets(secrets);
    const details: string[] = [];

    for (const secret of uniqueSecrets) {
      const inspect = await this.runDocker([
        "secret",
        "inspect",
        secret.dockerSecretName,
      ]);

      if (inspect.exitCode === 0) {
        details.push(`Docker secret ${secret.dockerSecretName} already exists`);
        continue;
      }

      const create = await this.runDocker(
        ["secret", "create", secret.dockerSecretName, "-"],
        secret.value,
      );

      if (create.exitCode !== 0) {
        return {
          success: false,
          message: `Docker secret create failed for ${secret.dockerSecretName}`,
          details: [
            ...details,
            create.command,
            create.stderr || create.stdout || `Exit code ${create.exitCode}`,
          ].join("\n"),
        };
      }

      details.push(`Created Docker secret ${secret.dockerSecretName}`);
    }

    return {
      success: true,
      message: `Provisioned ${uniqueSecrets.length} secret(s)`,
      details: details.join("\n"),
    };
  }

  private uniqueSecrets(secrets: ProvisionSecret[]) {
    return Array.from(
      new Map(secrets.map((secret) => [secret.dockerSecretName, secret])).values(),
    );
  }

  private runDocker(args: string[], stdin?: string | Buffer) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_SECRET_PROVISION_TIMEOUT_MS",
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
            ? `docker secret command terminated by ${signal}`
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
