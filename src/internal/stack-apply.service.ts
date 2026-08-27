import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

type ApplyResult = {
  command: string;
  stackName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class StackApplyService {
  constructor(private readonly config: ConfigService) {}

  applyStack(params: {
    stackName: string;
    renderedStack: string;
  }): Promise<ApplyResult> {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>("DOCKER_APPLY_TIMEOUT_MS", 120000);
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

    return new Promise((resolve) => {
      const child = spawn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const command = `docker ${args.join(" ")}`;
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
          stackName: params.stackName,
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
          stackName: params.stackName,
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal
            ? `docker stack deploy terminated by ${signal}`
            : this.decode(stderr),
        });
      });

      child.stdin.end(params.renderedStack);
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
