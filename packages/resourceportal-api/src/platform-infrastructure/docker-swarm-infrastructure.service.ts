import { Injectable, Logger } from "@nestjs/common";
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
  private readonly logger = new Logger(DockerSwarmInfrastructureService.name);

  constructor(private readonly config: ConfigService) {}

  async inspectSwarm(): Promise<{ dockerClusterId: string } | null> {
    const result = await this.runDocker([
      "info",
      "--format",
      "{{json .Swarm}}",
    ]);

    if (result.exitCode !== 0 || !result.stdout) {
      this.logger.warn(
        `Swarm observation failed at docker info: exitCode=${result.exitCode} stderr=${JSON.stringify(result.stderr)}`,
      );
      return null;
    }

    try {
      const swarm = JSON.parse(result.stdout) as DockerSwarmInfo;
      if (
        swarm.LocalNodeState !== "active" ||
        typeof swarm.Cluster?.ID !== "string" ||
        swarm.Cluster.ID.length === 0
      ) {
        this.logger.warn(
          `Swarm observation rejected docker info payload: localNodeState=${JSON.stringify(swarm.LocalNodeState)} clusterIdPresent=${typeof swarm.Cluster?.ID === "string" && swarm.Cluster.ID.length > 0}`,
        );
        return null;
      }

      return { dockerClusterId: swarm.Cluster.ID };
    } catch (error) {
      this.logger.warn(
        `Swarm observation could not parse docker info JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  async listNodes(): Promise<ObservedSwarmNode[] | null> {
    // docker node ls does not support --no-trunc. Its .ID formatting field is
    // already the full Swarm node ID and is safe to pass to docker node inspect.
    const list = await this.runDocker([
      "node",
      "ls",
      "--format",
      "{{.ID}}",
    ]);

    if (list.exitCode !== 0) {
      this.logger.warn(
        `Swarm observation failed at docker node ls: exitCode=${list.exitCode} stderr=${JSON.stringify(list.stderr)}`,
      );
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
        this.logger.warn(
          `Swarm observation failed at docker node inspect: nodeId=${nodeId} exitCode=${inspect.exitCode} stderr=${JSON.stringify(inspect.stderr)}`,
        );
        return null;
      }

      try {
        const node = parseDockerNodeInspect(JSON.parse(inspect.stdout));
        if (!node) {
          this.logger.warn(
            `Swarm observation rejected docker node inspect payload: nodeId=${nodeId}`,
          );
          return null;
        }
        nodes.push(node);
      } catch (error) {
        this.logger.warn(
          `Swarm observation could not parse docker node inspect JSON: nodeId=${nodeId} error=${error instanceof Error ? error.message : "unknown error"}`,
        );
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
