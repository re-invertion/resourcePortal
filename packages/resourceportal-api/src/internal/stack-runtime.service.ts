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
    services: Array<{
      stackName: string;
      serviceName: string;
      replicas: number;
    }>,
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
    const addOrUpdate = Object.entries(desiredTraefik).filter(
      ([key, value]) => currentTraefik[key] !== value,
    );

    if (removeKeys.length === 0 && addOrUpdate.length === 0) {
      return { success: true, changed: false };
    }

    const args = ["service", "update"];
    for (const key of removeKeys) {
      args.push("--label-rm", key);
    }
    for (const [key, value] of addOrUpdate) {
      args.push("--label-add", `${key}=${value}`);
    }
    args.push(input.serviceName);

    const update = await this.runDocker(args);
    return {
      success: update.exitCode === 0,
      changed: update.exitCode === 0,
    };
  }

  async reconcileAppGroupNetwork(input: {
    networkName: string;
    traefikRequired: boolean;
  }) {
    this.assertManagedAppGroupNetwork(input.networkName);
    const ensured = await this.ensureAppGroupNetwork(input.networkName);
    if (!ensured.success) return ensured;

    const membership = await this.reconcileTraefikNetworkMembership(
      input.networkName,
      input.traefikRequired,
    );
    if (!membership.success) {
      return {
        success: false,
        changed: ensured.changed || membership.changed,
        error: membership.error,
      };
    }
    return {
      success: true,
      changed: ensured.changed || membership.changed,
    };
  }

  async reconcileLegacyIngressNetwork(input: {
    networkName: string;
    required: boolean;
  }) {
    this.assertManagedLegacyIngressNetwork(input.networkName);
    return input.required
      ? this.ensureLegacyIngressNetwork(input.networkName)
      : this.removeLegacyIngressNetwork(input.networkName);
  }

  async reconcileServiceNetwork(input: {
    serviceName: string;
    networkName: string;
    required: boolean;
  }) {
    this.assertManagedTenantNetwork(input.networkName);
    const network = await this.inspectNetwork(input.networkName);
    if (!network.success) {
      return !input.required && network.missing
        ? { success: true, changed: false }
        : { success: false, changed: false };
    }

    const serviceNetworks = await this.inspectServiceNetworks(
      input.serviceName,
    );
    if (!serviceNetworks.success) {
      return { success: false, changed: false };
    }
    const attached = serviceNetworks.networkIds.includes(network.networkId);
    if (attached === input.required) {
      return { success: true, changed: false };
    }

    const update = await this.runDocker([
      "service",
      "update",
      input.required ? "--network-add" : "--network-rm",
      input.networkName,
      input.serviceName,
    ]);
    return {
      success: update.exitCode === 0,
      changed: update.exitCode === 0,
    };
  }

  private async ensureAppGroupNetwork(networkName: string) {
    const network = await this.inspectNetwork(networkName);
    if (network.success) {
      return { success: true, changed: false };
    }
    if (!network.missing) {
      return { success: false, changed: false, error: network.error };
    }

    const create = await this.runDocker([
      "network",
      "create",
      "--driver",
      "overlay",
      "--label",
      "resourceportal.managed=true",
      "--label",
      "resourceportal.network.kind=app-group",
      networkName,
    ]);
    return create.exitCode === 0
      ? { success: true, changed: true }
      : {
          success: false,
          changed: false,
          error:
            create.stderr ||
            create.stdout ||
            `docker network create ${networkName} failed`,
        };
  }

  private async ensureLegacyIngressNetwork(networkName: string) {
    let changed = false;
    const network = await this.inspectNetwork(networkName);
    if (!network.success) {
      if (!network.missing) {
        return { success: false, changed: false };
      }
      const create = await this.runDocker([
        "network",
        "create",
        "--driver",
        "overlay",
        "--label",
        "resourceportal.managed=true",
        "--label",
        "resourceportal.network.kind=app-group-ingress-legacy",
        networkName,
      ]);
      if (create.exitCode !== 0) {
        return { success: false, changed: false };
      }
      changed = true;
    }

    const membership = await this.reconcileTraefikNetworkMembership(
      networkName,
      true,
    );
    if (!membership.success) {
      return {
        success: false,
        changed: changed || membership.changed,
        error: membership.error,
      };
    }
    return {
      success: true,
      changed: changed || membership.changed,
    };
  }

  private async removeLegacyIngressNetwork(networkName: string) {
    const network = await this.inspectNetwork(networkName);
    if (!network.success) {
      return network.missing
        ? { success: true, changed: false }
        : { success: false, changed: false };
    }

    const membership = await this.reconcileTraefikNetworkMembership(
      networkName,
      false,
    );
    if (!membership.success) return membership;

    const remove = await this.runDocker(["network", "rm", networkName]);
    if (remove.exitCode !== 0 && !this.isMissingNetwork(remove.stderr)) {
      return { success: false, changed: membership.changed };
    }
    return { success: true, changed: true };
  }

  private async reconcileTraefikNetworkMembership(
    networkName: string,
    required: boolean,
  ) {
    const network = await this.inspectNetwork(networkName);
    if (!network.success) {
      return !required && network.missing
        ? { success: true, changed: false }
        : { success: false, changed: false };
    }

    const traefik = this.traefikServiceName();
    const serviceNetworks = await this.inspectServiceNetworks(traefik);
    if (!serviceNetworks.success) {
      return !required && serviceNetworks.missing
        ? { success: true, changed: false }
        : { success: false, changed: false, error: serviceNetworks.error };
    }
    const attached = serviceNetworks.networkIds.includes(network.networkId);
    if (attached === required) {
      return { success: true, changed: false };
    }

    const update = await this.runDocker([
      "service",
      "update",
      required ? "--network-add" : "--network-rm",
      networkName,
      traefik,
    ]);
    return update.exitCode === 0
      ? { success: true, changed: true }
      : {
          success: false,
          changed: false,
          error:
            update.stderr ||
            update.stdout ||
            `docker service update ${traefik} failed`,
        };
  }

  private async inspectNetwork(networkName: string) {
    const result = await this.runDocker([
      "network",
      "inspect",
      networkName,
      "--format",
      "{{.Id}}",
    ]);
    const networkId = result.stdout.trim();
    if (result.exitCode === 0 && networkId) {
      return { success: true as const, missing: false, networkId };
    }
    return {
      success: false as const,
      missing: this.isMissingNetwork(result.stderr),
      networkId: "",
      error:
        result.stderr ||
        result.stdout ||
        `docker network inspect ${networkName} failed`,
    };
  }

  private async inspectServiceNetworks(serviceName: string) {
    const result = await this.runDocker([
      "service",
      "inspect",
      serviceName,
      "--format",
      "{{range .Spec.TaskTemplate.Networks}}{{println .Target}}{{end}}",
    ]);
    if (result.exitCode !== 0) {
      return {
        success: false as const,
        missing: this.isMissingService(result.stderr),
        networkIds: [] as string[],
        error:
          result.stderr ||
          result.stdout ||
          `docker service inspect ${serviceName} failed`,
      };
    }
    return {
      success: true as const,
      missing: false as const,
      networkIds: result.stdout.split(/\s+/).filter(Boolean),
    };
  }

  private traefikServiceName() {
    return (
      this.config.get<string>("TRAEFIK_SERVICE_NAME") ??
      "resourceportal-control-plane_traefik"
    );
  }

  private assertManagedAppGroupNetwork(networkName: string) {
    if (!/^rp-appgroup-[a-z0-9-]+$/.test(networkName)) {
      throw new Error(`Refusing unmanaged App Group network: ${networkName}`);
    }
  }

  private assertManagedLegacyIngressNetwork(networkName: string) {
    if (!/^rp-ingress-[a-z0-9-]+$/.test(networkName)) {
      throw new Error(
        `Refusing unmanaged legacy ingress network: ${networkName}`,
      );
    }
  }

  private assertManagedTenantNetwork(networkName: string) {
    if (
      !/^rp-appgroup-[a-z0-9-]+$/.test(networkName) &&
      !/^rp-ingress-[a-z0-9-]+$/.test(networkName)
    ) {
      throw new Error(`Refusing unmanaged tenant network: ${networkName}`);
    }
  }

  private isMissingNetwork(stderr: string) {
    const normalized = stderr.toLowerCase();
    return (
      normalized.includes("no such network") ||
      normalized.includes("network not found") ||
      /network\s+[^\n]+\s+not found/.test(normalized)
    );
  }

  private isMissingService(stderr: string) {
    const normalized = stderr.toLowerCase();
    return (
      normalized.includes("no such service") ||
      normalized.includes("service not found")
    );
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

        const replicas = this.parseReplicas(service.Replicas);

        if (replicas === null) {
          throw new Error("Unexpected docker service replica value");
        }

        return {
          name: service.Name,
          image: service.Image,
          runningReplicas: replicas.running,
          desiredReplicas: replicas.desired,
        };
      });
    } catch {
      return null;
    }
  }

  private parseReplicas(value: string) {
    const [runningRaw, desiredRaw] = value.trim().split("/");
    if (runningRaw === undefined || desiredRaw === undefined) {
      return null;
    }

    const running = Number.parseInt(runningRaw, 10);
    const desired = Number.parseInt(desiredRaw, 10);
    if (
      !Number.isFinite(running) ||
      running < 0 ||
      !Number.isFinite(desired) ||
      desired < 0
    ) {
      return null;
    }
    return { running, desired };
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
      const command = `docker ${fullArgs.join(" ")}`;
      let settled = false;
      const finish = (result: RuntimeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const finishFromExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        finish({
          command,
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal
            ? `docker runtime command terminated by ${signal}`
            : this.decode(stderr),
        });
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish({
          command,
          exitCode: 124,
          stdout: this.decode(stdout),
          stderr: `${command} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        finish({
          command,
          exitCode: 127,
          stdout: this.decode(stdout),
          stderr: error.message,
        });
      });
      child.on("exit", finishFromExit);
      child.on("close", finishFromExit);
    });
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}
