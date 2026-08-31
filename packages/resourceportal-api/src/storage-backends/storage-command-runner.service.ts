import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

export type StorageCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class StorageCommandRunnerService {
  constructor(private readonly config: ConfigService) {}

  run(program: string, args: string[]): Promise<StorageCommandResult> {
    const timeoutMs = this.config.get<number>("STORAGE_COMMAND_TIMEOUT_MS", 120000);

    return new Promise((resolve) => {
      const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
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
        resolve({ exitCode: 127, stdout: this.decode(stdout), stderr: error.message });
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal ? `command terminated by ${signal}` : this.decode(stderr),
        });
      });
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
