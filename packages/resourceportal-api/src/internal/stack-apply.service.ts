import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { parse, stringify } from "yaml";

type ApplyResult = {
  command: string;
  stackName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ComposeService = {
  deploy?: {
    labels?: Record<string, unknown> | unknown[];
  };
  networks?: string[] | Record<string, unknown>;
};

type ComposeStack = {
  networks?: Record<string, unknown>;
  services?: Record<string, ComposeService>;
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
    const renderedStack = this.attachIngressNetworks(params.renderedStack);
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

      child.stdin.end(renderedStack);
    });
  }

  private attachIngressNetworks(renderedStack: string) {
    let stack: ComposeStack;
    try {
      stack = parse(renderedStack) as ComposeStack;
    } catch {
      return renderedStack;
    }

    if (!stack || typeof stack !== "object" || !stack.services) {
      return renderedStack;
    }

    const externalNetworks = new Set<string>();
    for (const service of Object.values(stack.services)) {
      const network = this.traefikSwarmNetwork(service.deploy?.labels);
      if (!network) {
        continue;
      }

      externalNetworks.add(network);
      if (Array.isArray(service.networks)) {
        if (!service.networks.includes(network)) {
          service.networks.push(network);
        }
      } else {
        service.networks = {
          ...(service.networks ?? {}),
          [network]: {},
        };
      }
    }

    if (externalNetworks.size === 0) {
      return renderedStack;
    }

    stack.networks ??= {};
    for (const network of externalNetworks) {
      stack.networks[network] = { external: true, name: network };
    }

    return stringify(stack, { lineWidth: 0 });
  }

  private traefikSwarmNetwork(labels: Record<string, unknown> | unknown[] | undefined) {
    if (!labels) {
      return undefined;
    }

    if (Array.isArray(labels)) {
      const prefix = "traefik.swarm.network=";
      const label = labels.find(
        (value): value is string =>
          typeof value === "string" && value.startsWith(prefix),
      );
      return label?.slice(prefix.length).trim() || undefined;
    }

    const value = labels["traefik.swarm.network"];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
