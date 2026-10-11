import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RegistryAuthType } from "@prisma/client";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDockerContextWithoutRegistryCredentials } from "./isolated-docker-context";

export type RegistryLogin = {
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
    const { auth } = await this.withScopedLogin(registries, () => Promise.resolve(undefined));
    return auth;
  }

  /** Keep credentials scoped to one apply attempt, including concurrent tenants. */
  async withScopedLogin<T>(
    registries: RegistryLogin[],
    action: (dockerConfigPath: string) => Promise<T>,
  ): Promise<{ auth: RegistryAuthResult; result?: T }> {
    const dockerConfigPath = await mkdtemp(join(tmpdir(), "resourceportal-docker-auth-"));
    try {
      await chmod(dockerConfigPath, 0o700);
      await copyDockerContextWithoutRegistryCredentials(
        dockerConfigPath,
        this.config.get<string>("DOCKER_CONTEXT"),
      );
      return await this.loginScoped(registries, dockerConfigPath, action);
    } finally {
      await rm(dockerConfigPath, { recursive: true, force: true });
    }
  }

  private async loginScoped<T>(
    registries: RegistryLogin[],
    dockerConfigPath: string,
    action: (dockerConfigPath: string) => Promise<T>,
  ): Promise<{ auth: RegistryAuthResult; result?: T }> {
    const requiredRegistries = registries.filter(
      (registry) => registry.authType !== RegistryAuthType.None,
    );
    const details: string[] = [];

    for (const registry of requiredRegistries) {
      const loginUsername = this.loginUsername(registry);

      if (!loginUsername || !registry.credential) {
        return { auth: {
          success: false,
          message: `Registry credentials are incomplete for ${registry.host}`,
          details: `Registry ${registry.host} requires valid credentials for docker login`,
        } };
      }

      const result = await this.runDocker(
        [
          "login",
          registry.host,
          "--username",
          loginUsername,
          "--password-stdin",
        ],
        registry.credential,
        dockerConfigPath,
      );

      if (result.exitCode !== 0) {
        return { auth: {
          success: false,
          message: `Docker login failed for ${registry.host}`,
          details: [
            ...details,
            result.command,
            result.stderr || result.stdout || `Exit code ${result.exitCode}`,
          ].join("\n"),
        } };
      }

      details.push(`Docker login succeeded for ${registry.host}`);
    }

    return {
      auth: {
        success: true,
        message: `Authenticated ${requiredRegistries.length} registry(ies)`,
        details: details.join("\n"),
      },
      result: await action(dockerConfigPath),
    };
  }

  private loginUsername(registry: RegistryLogin) {
    if (registry.authType === RegistryAuthType.Token) {
      return registry.username || "token";
    }

    return registry.username;
  }

  private runDocker(args: string[], stdin: string, dockerConfigPath: string) {
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
        env: { ...process.env, DOCKER_CONFIG: dockerConfigPath },
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
