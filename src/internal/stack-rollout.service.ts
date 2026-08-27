import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";

type ExpectedService = {
  name: string;
  desiredReplicas: number;
};

type RolloutResult = {
  success: boolean;
  message: string;
  details: string;
};

type DockerServiceRow = {
  Name?: string;
  Replicas?: string;
};

@Injectable()
export class StackRolloutService {
  constructor(private readonly config: ConfigService) {}

  async waitForRollout(params: {
    stackName: string;
    expectedServices: ExpectedService[];
  }): Promise<RolloutResult> {
    const timeoutMs = this.config.get<number>(
      "DOCKER_ROLLOUT_TIMEOUT_MS",
      300000,
    );
    const pollIntervalMs = this.config.get<number>(
      "DOCKER_ROLLOUT_POLL_INTERVAL_MS",
      5000,
    );
    const deadline = Date.now() + timeoutMs;
    let lastDetails = "";

    while (Date.now() <= deadline) {
      const result = await this.inspectStackServices(params.stackName);

      if (result.exitCode !== 0) {
        return {
          success: false,
          message: "Docker stack services failed",
          details: result.stderr || result.stdout || `Exit code ${result.exitCode}`,
        };
      }

      const rows = this.parseServiceRows(result.stdout);
      const status = this.evaluateServices(rows, params.expectedServices);
      lastDetails = status.details;

      if (status.success) {
        return {
          success: true,
          message: "Rollout completed",
          details: status.details,
        };
      }

      await this.sleep(pollIntervalMs);
    }

    return {
      success: false,
      message: "Rollout timed out",
      details: lastDetails || "No rollout status available",
    };
  }

  private inspectStackServices(stackName: string) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const args = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      "stack",
      "services",
      stackName,
      "--format",
      "{{json .}}",
    ];

    return this.runDocker(args);
  }

  private runDocker(args: string[]) {
    return new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        settled = true;
        resolve({
          exitCode: 127,
          stdout: this.decode(stdout),
          stderr: error.message,
        });
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }

        resolve({
          exitCode: code ?? 1,
          stdout: this.decode(stdout),
          stderr: this.decode(stderr),
        });
      });
    });
  }

  private parseServiceRows(stdout: string) {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerServiceRow);
  }

  private evaluateServices(
    rows: DockerServiceRow[],
    expectedServices: ExpectedService[],
  ) {
    const servicesByName = new Map(rows.map((row) => [row.Name, row]));
    const details: string[] = [];

    for (const expected of expectedServices) {
      const service = servicesByName.get(expected.name);

      if (!service) {
        details.push(`${expected.name}: missing`);
        continue;
      }

      const replicas = this.parseReplicas(service.Replicas);
      details.push(
        `${expected.name}: ${replicas.running}/${replicas.desired} replicas`,
      );

      if (
        replicas.running !== expected.desiredReplicas ||
        replicas.desired !== expected.desiredReplicas
      ) {
        return {
          success: false,
          details: details.join("\n"),
        };
      }
    }

    return {
      success: true,
      details: details.join("\n"),
    };
  }

  private parseReplicas(value: string | undefined) {
    const [running = "0", desired = "0"] = (value ?? "0/0").split("/");

    return {
      running: Number(running),
      desired: Number(desired),
    };
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
