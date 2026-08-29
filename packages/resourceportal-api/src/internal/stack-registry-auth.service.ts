import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RegistryAuthType } from "@prisma/client";
import { spawn } from "node:child_process";

type RegistryLogin = {
  host: string;
  authType: RegistryAuthType;
  username: string | null;
  credential: string | null;
};

type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RegistryAuthResult = {
  success: boolean;
  message: string;
  details: string;
};

@Injectable()
export class StackRegistryAuthService {
  constructor(private readonly config: ConfigService) {}

  async login(registries: RegistryLogin[]): Promise<RegistryAuthResult> {
    const requiredRegistries = registries.filter(
      (registry) => registry.authType !== RegistryAuthType.None,
    );
    const details: string[] = [];

    for (const registry of requiredRegistries) {
      if (!registry.username || !registry.credential) {
        return {
          success: false,
          message: `Registry credentials are incomplete for ${registry.host}`,
          details: `Registry ${registry.host} requires username and credential for docker login`,
        };
      }

      const result = await this.runDocker(
        ["login", registry.host, "--username", registry.username, "--password-stdin"],
        registry.credential,
      );

      if (result.exitCode !== 0) {
        return {
          success: false,
          message: `Docker login failed for ${registry.host}`,
          details: [
            ...details,
            result.command,
            result.stderr || result.stdout || `Exit code ${result.exitCode}`,
          ].join("\n"),
        };
      }

      details.push(`Docker login succeeded for ${registry.host}`);
    }

    return {
      success: true,
      message: `Authenticated ${requiredRegistries.length} registry(ies)`,
      details: details.join("\n"),
    };
  }

  private runDocker(args: string[], stdin: string) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_REGISTRY_AUTH_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [...(dockerContext ? ["--context", dockerContext] : []), ...args];
    const command = `docker ${fullArgs.join(" ")}`;

    return new Promise<CommandResult>((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: ["pipe", "pipe", "pipe"],
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
            ? `docker login terminated by ${signal}`
            : this.decode(stderr),
        });
      });
      child.stdin.end(stdin);
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
