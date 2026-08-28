import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

type RuntimeResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class StackRuntimeService {
  constructor(private readonly config: ConfigService) {}

  async scaleServices(
    services: Array<{ stackName: string; serviceName: string; replicas: number }>,
  ) {
    const results: RuntimeResult[] = [];

    for (const service of services) {
      results.push(
        await this.runDocker([
          "service",
          "scale",
          `${service.stackName}_${service.serviceName}=${service.replicas}`,
        ]),
      );
    }

    return results;
  }

  async restartServices(
    services: Array<{ stackName: string; serviceName: string }>,
  ) {
    const results: RuntimeResult[] = [];

    for (const service of services) {
      results.push(
        await this.runDocker([
          "service",
          "update",
          "--force",
          `${service.stackName}_${service.serviceName}`,
        ]),
      );
    }

    return results;
  }

  private runDocker(args: string[]): Promise<RuntimeResult> {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_RUNTIME_OPERATION_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [...(dockerContext ? ["--context", dockerContext] : []), ...args];

    return new Promise((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const command = `docker ${fullArgs.join(" ")}`;
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
            ? `docker runtime command terminated by ${signal}`
            : this.decode(stderr),
        });
      });
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
