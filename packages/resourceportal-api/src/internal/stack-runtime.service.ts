import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { ObservedRuntimeService } from "../app-groups/runtime-drift";

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

  async reconcileTraefikLabels(input: {
    serviceName: string;
    desiredLabels: Record<string, string>;
  }) {
    const inspect = await this.runDocker([
      "service",
      "inspect",
      input.serviceName,
      "--format",
      "{{json .Spec.Labels}}",
    ]);

    if (inspect.exitCode !== 0) {
      return { success: false, changed: false };
    }

    let current: Record<string, string>;
    try {
      const parsed = JSON.parse(inspect.stdout || "{}") as Record<
        string,
        unknown
      >;
      current = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return { success: false, changed: false };
    }

    const currentTraefik = Object.fromEntries(
      Object.entries(current).filter(([key]) => key.startsWith("traefik.")),
    );
    const desiredTraefik = Object.fromEntries(
      Object.entries(input.desiredLabels).filter(([key]) =>
        key.startsWith("traefik."),
      ),
    );

    const removeKeys = Object.keys(currentTraefik).filter(
      (key) => !(key in desiredTraefik),
    );
    const addEntries = Object.entries(desiredTraefik).filter(
      ([key, value]) => currentTraefik[key] !== value,
    );

    if (removeKeys.length === 0 && addEntries.length === 0) {
      return { success: true, changed: false };
    }

    const args = ["service", "update"];
    for (const key of removeKeys) {
      args.push("--label-rm", key);
    }
    for (const [key, value] of addEntries) {
      args.push("--label-add", `${key}=${value}`);
    }
    args.push(input.serviceName);

    const update = await this.runDocker(args);
    return {
      success: update.exitCode === 0,
      changed: update.exitCode === 0,
    };
  }

  async inspectStackServices(
    stackName: string,
  ): Promise<ObservedRuntimeService[] | null> {
    const result = await this.runDocker([
      "stack",
      "services",
      stackName,
      "--format",
      "{{json .}}",
    ]);

    if (result.exitCode !== 0) {
      return null;
    }

    if (!result.stdout) {
      return [];
    }

    try {
      return result.stdout.split("\n").map((line) => {
        const service = JSON.parse(line) as {
          Name?: unknown;
          Image?: unknown;
          Replicas?: unknown;
        };

        if (
          typeof service.Name !== "string" ||
          typeof service.Image !== "string" ||
          typeof service.Replicas !== "string"
        ) {
          throw new Error("Unexpected docker stack services output");
        }

        const desiredReplicas = this.parseDesiredReplicas(service.Replicas);

        if (desiredReplicas === null) {
          throw new Error("Unexpected docker service replica value");
        }

        return {
          name: service.Name,
          image: service.Image,
          desiredReplicas,
        };
      });
    } catch {
      return null;
    }
  }

  private parseDesiredReplicas(value: string) {
    const [, desired] = value.trim().split("/");

    if (desired === undefined) {
      return null;
    }

    const parsed = Number.parseInt(desired, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private runDocker(args: string[]): Promise<RuntimeResult> {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const timeoutMs = this.config.get<number>(
      "DOCKER_RUNTIME_OPERATION_TIMEOUT_MS",
      120000,
    );
    const fullArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      ...args,
    ];

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
