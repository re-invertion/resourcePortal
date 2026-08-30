import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import {
  ObservedSwarmNode,
  parseDockerNodeInspect,
} from "./docker-swarm-parsing";
import { RemoteLocationAvailability } from "./swarm-infrastructure.logic";

type RuntimeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type DockerSwarmInfo = {
  LocalNodeState?: unknown;
  Cluster?: {
    ID?: unknown;
  };
};

@Injectable()
export class DockerSwarmInfrastructureService {
  constructor(private readonly config: ConfigService) {}

  async inspectSwarm(): Promise<{ dockerClusterId: string } | null> {
    const result = await this.runDocker([
      "info",
      "--format",
      "{{json .Swarm}}",
    ]);

    if (result.exitCode !== 0 || !result.stdout) {
      return null;
    }

    try {
      const swarm = JSON.parse(result.stdout) as DockerSwarmInfo;
      if (
        swarm.LocalNodeState !== "active" ||
        typeof swarm.Cluster?.ID !== "string" ||
        swarm.Cluster.ID.length === 0
      ) {
        return null;
      }

      return { dockerClusterId: swarm.Cluster.ID };
    } catch {
      return null;
    }
  }

  async listNodes(): Promise<ObservedSwarmNode[] | null> {
    const list = await this.runDocker([
      "node",
      "ls",
      "--no-trunc",
      "--format",
      "{{.ID}}",
    ]);

    if (list.exitCode !== 0) {
      return null;
    }

    const nodeIds = list.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const nodes: ObservedSwarmNode[] = [];

    for (const nodeId of nodeIds) {
      const inspect = await this.runDocker([
        "node",
        "inspect",
        nodeId,
        "--format",
        "{{json .}}",
      ]);

      if (inspect.exitCode !== 0 || !inspect.stdout) {
        return null;
      }

      try {
        const node = parseDockerNodeInspect(JSON.parse(inspect.stdout));
        if (!node) {
          return null;
        }
        nodes.push(node);
      } catch {
        return null;
      }
    }

    return nodes;
  }

  async setNodeAvailability(
    nodeId: string,
    availability: Extract<RemoteLocationAvailability, "Active" | "Drain">,
  ) {
    const result = await this.runDocker([
      "node",
      "update",
      "--availability",
      availability.toLowerCase(),
      nodeId,
    ]);
    return result.exitCode === 0;
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
