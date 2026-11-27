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
    readinessStabilityChecks?: number;
  }): Promise<RolloutResult> {
    const timeoutMs = this.positiveIntegerConfig(
      "DOCKER_ROLLOUT_TIMEOUT_MS",
      300000,
    );
    const pollIntervalMs = this.positiveIntegerConfig(
      "DOCKER_ROLLOUT_POLL_INTERVAL_MS",
      5000,
    );
    const deadline = Date.now() + timeoutMs;
    let lastDetails = "";
    let consecutiveReady = 0;
    const stabilityChecks = Math.max(1, Math.min(10, params.readinessStabilityChecks ?? 1));

    while (Date.now() <= deadline) {
      const result = await this.inspectStackServices(params.stackName);

      if (result.exitCode !== 0) {
        return {
          success: false,
          message: "Docker stack services failed",
          details:
            result.stderr || result.stdout || `Exit code ${result.exitCode}`,
        };
      }

      const rows = this.parseServiceRows(result.stdout);
      const status = this.evaluateServices(rows, params.expectedServices);
      lastDetails = status.details;

      // Service replica summaries omit tasks still shutting down. Keep the
      // reservation until every reachable node confirms the exact live census.
      const tasksReady = status.success && await this.verifyStackTaskCensus(params.stackName, params.expectedServices, deadline);
      if (status.success && !tasksReady) lastDetails += "\nPrevious stack tasks or node census not yet verified";
      consecutiveReady = tasksReady ? consecutiveReady + 1 : 0;
      if (consecutiveReady >= stabilityChecks) {
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

  private async verifyStackTaskCensus(stackName: string, expected: ExpectedService[], deadline: number): Promise<boolean> {
    if (!/^[a-z0-9_-]{1,128}$/.test(stackName)) return false;
    const context = this.config.get<string>("DOCKER_CONTEXT");
    const prefix = context ? ["--context", context] : [];
    const nodes = await this.runDocker([...prefix, "node", "ls", "--format", "{{.ID}}|{{.Status}}"]);
    if (nodes.exitCode !== 0 || !nodes.stdout.trim()) return false;
    const ids = new Set<string>();
    for (const line of nodes.stdout.split("\n")) {
      const [rawId, status] = line.split("|");
      const id = rawId?.trim().replace(/\s+\*$/, "");
      if (!id || !/^[a-z0-9]{20,40}$/.test(id) || status !== "Ready" || ids.has(id)) return false;
      ids.add(id);
    }
    if (ids.size > 128) return false;
    const counts = new Map(expected.map(service => [service.name, 0]));
    for (const id of ids) {
      if (Date.now() >= deadline) return false;
      const tasks = await this.runDocker([...prefix, "node", "ps", id, "--no-trunc", "--format", "{{.Name}}|{{.DesiredState}}|{{.CurrentState}}"]);
      if (tasks.exitCode !== 0) return false;
      for (const line of tasks.stdout.split("\n").filter(Boolean)) {
        const [name, desired, state] = line.split("|");
        if (!name?.startsWith(stackName + "_")) continue;
        if (!state || !desired) return false;
        if (/^(?:Shutdown|Complete|Failed|Rejected)\b/i.test(state)) continue;
        const service = name.split(".")[0];
        if (!counts.has(service) || desired !== "Running" || !/^Running\b/.test(state)) return false;
        counts.set(service, (counts.get(service) ?? 0) + 1);
      }
    }
    return Date.now() <= deadline && expected.every(service => counts.get(service.name) === service.desiredReplicas);
  }

  /**
   * Successful Swarm service convergence does not mean stopped tasks have
   * actually exited on every node. Never release a dedicated physical GPU
   * while an old task may still have access to its NVIDIA device.
   */
  async verifyRemovedGpuServiceTasks(
    stackName: string, removedServiceNames: readonly string[],
  ): Promise<boolean> {
    if (!removedServiceNames.length) return true;
    if (!/^[a-z0-9_-]{1,128}$/.test(stackName) ||
        removedServiceNames.some((name) => !/^[a-z0-9_-]{1,128}$/.test(name))) return false;
    const services = new Set(removedServiceNames.map((name) => stackName + "_" + name));
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const prefix = dockerContext ? ["--context", dockerContext] : [];
    const nodes = await this.runDocker([
      ...prefix, "node", "ls", "--format", "{{.ID}}|{{.Status}}|{{.Availability}}",
    ]);
    if (nodes.exitCode !== 0 || !nodes.stdout.trim()) return false;
    const ids: string[] = [];
    for (const line of nodes.stdout.split("\n").filter(Boolean)) {
      const [rawId, status, availability] = line.split("|");
      const id = rawId?.trim().replace(/\s+\*$/, "");
      if (!id || !/^[a-z0-9]{20,40}$/.test(id) ||
          status !== "Ready" || availability !== "Active") return false;
      ids.push(id);
    }
    if (!ids.length || ids.length > 128) return false;

    const current = await this.runDocker([
      ...prefix, "service", "ls",
      "--filter", "label=com.docker.stack.namespace=" + stackName,
      "--format", "{{.Name}}",
    ]);
    if (current.exitCode !== 0 ||
        current.stdout.split("\n").filter(Boolean).some((name) => services.has(name))) return false;

    for (const id of ids) {
      const tasks = await this.runDocker([
        ...prefix, "node", "ps", id, "--no-trunc", "--format", "{{.Name}}|{{.CurrentState}}",
      ]);
      if (tasks.exitCode !== 0) return false;
      for (const line of tasks.stdout.split("\n").filter(Boolean)) {
        const [name, state] = line.split("|");
        if (!name || ![...services].some((service) => name.startsWith(service + "."))) continue;
        if (!state || !/^(?:Shutdown|Complete|Failed|Rejected)\b/i.test(state)) return false;
      }
    }
    return true;
  }


  /**
   * A gpu:0 service may still be Running. Prove that its current service
   * template and every non-terminal task on every Swarm node have detached
   * from NVIDIA before releasing the old database reservation. Fail closed
   * when a node or task cannot be inspected.
   */
  async verifyDetachedGpuServiceTasks(
    stackName: string, serviceNames: readonly string[],
  ): Promise<boolean> {
    if (!serviceNames.length) return true;
    if (!/^[a-z0-9_-]{1,128}$/.test(stackName) ||
        serviceNames.some((name) => !/^[a-z0-9_-]{1,128}$/.test(name))) return false;
    const services = new Set(serviceNames.map((name) => stackName + "_" + name));
    const context = this.config.get<string>("DOCKER_CONTEXT");
    const prefix = context ? ["--context", context] : [];
    const nodes = await this.runDocker([
      ...prefix, "node", "ls", "--format", "{{.ID}}|{{.Status}}|{{.Availability}}",
    ]);
    if (nodes.exitCode !== 0 || !nodes.stdout.trim()) return false;
    const ids: string[] = [];
    for (const line of nodes.stdout.split("\n").filter(Boolean)) {
      const [rawId, status, availability] = line.split("|");
      const id = rawId?.trim().replace(/\s+\*$/, "");
      if (!id || !/^[a-z0-9]{20,40}$/.test(id) ||
          status !== "Ready" || availability !== "Active") return false;
      ids.push(id);
    }
    if (!ids.length || ids.length > 128) return false;

    for (const service of services) {
      const current = await this.runDocker([
        ...prefix, "service", "inspect", service,
        "--format", "{{json .Spec.TaskTemplate}}",
      ]);
      if (current.exitCode !== 0 || !gpuDetachedFromTaskTemplate(current.stdout)) return false;
    }

    for (const id of ids) {
      const tasks = await this.runDocker([
        ...prefix, "node", "ps", id, "--no-trunc",
        "--format", "{{.ID}}|{{.Name}}|{{.CurrentState}}",
      ]);
      if (tasks.exitCode !== 0) return false;
      for (const line of tasks.stdout.split("\n").filter(Boolean)) {
        const [taskId, name, state] = line.split("|");
        if (!name || ![...services].some((service) => name.startsWith(service + "."))) continue;
        if (!taskId || !/^[a-z0-9]{20,80}$/.test(taskId) || !state) return false;
        if (/^(?:Shutdown|Complete|Failed|Rejected)\b/i.test(state)) continue;
        const task = await this.runDocker([
          ...prefix, "inspect", "--type", "task", taskId,
          "--format", "{{json .Spec}}",
        ]);
        if (task.exitCode !== 0 || !gpuDetachedFromTaskTemplate(task.stdout)) return false;
      }
    }
    return true;
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
    const timeoutMs = this.positiveIntegerConfig(
      "DOCKER_RUNTIME_OPERATION_TIMEOUT_MS",
      120000,
    );

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
      const finish = (result: {
        exitCode: number;
        stdout: string;
        stderr: string;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish({
          exitCode: 124,
          stdout: this.decode(stdout),
          stderr: `docker stack services timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        finish({
          exitCode: 127,
          stdout: this.decode(stdout),
          stderr: error.message,
        });
      });
      const finishFromExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        finish({
          exitCode: signal ? 124 : (code ?? 1),
          stdout: this.decode(stdout),
          stderr: signal
            ? `docker stack services terminated by ${signal}`
            : this.decode(stderr),
        });
      };
      child.on("exit", finishFromExit);
      child.on("close", finishFromExit);
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
    const expectedNames = new Set(expectedServices.map((service) => service.name));
    const details: string[] = [];
    let allReady = true;

    for (const expected of expectedServices) {
      const service = servicesByName.get(expected.name);

      if (!service) {
        details.push(`${expected.name}: missing`);
        allReady = false;
        continue;
      }

      const replicas = this.parseReplicas(service.Replicas);
      if (!replicas) {
        details.push(`${expected.name}: invalid replicas (${service.Replicas ?? "unknown"})`);
        allReady = false;
        continue;
      }

      details.push(
        `${expected.name}: ${replicas.running}/${replicas.desired} replicas`,
      );
      if (
        replicas.running !== expected.desiredReplicas ||
        replicas.desired !== expected.desiredReplicas
      ) {
        allReady = false;
      }
    }

    for (const row of rows) {
      if (!row.Name || !expectedNames.has(row.Name)) {
        details.push(`${row.Name ?? "unknown"}: unexpected service`);
        allReady = false;
      }
    }

    return { success: allReady, details: details.join("\n") };
  }

  private parseReplicas(value: string | undefined) {
    if (!value || !/^[0-9]+\/[0-9]+$/.test(value.trim())) return null;
    const [running, desired] = value.trim().split("/").map(Number);
    if (!Number.isSafeInteger(running) || !Number.isSafeInteger(desired)) return null;
    return { running, desired };
  }

  private positiveIntegerConfig(key: string, fallback: number) {
    const raw = this.config.get<string | number | undefined>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private decode(chunks: Buffer[]) {
    return Buffer.concat(chunks).toString("utf8").trim();
  }
}

/** Strictly reject any task template that may still expose an NVIDIA GPU. */
export function gpuDetachedFromTaskTemplate(json: string): boolean {
  try {
    const spec = JSON.parse(json) as {
      ContainerSpec?: { Env?: unknown };
      Resources?: { Reservations?: { GenericResources?: unknown } };
    };
    if (!spec || typeof spec !== "object" || !spec.ContainerSpec ||
        !Array.isArray(spec.ContainerSpec.Env) ||
        !spec.ContainerSpec.Env.every((entry) => typeof entry === "string")) return false;
    const env = spec.ContainerSpec.Env;
    if (!env.includes("NVIDIA_VISIBLE_DEVICES=void") ||
        env.some((entry) => entry.startsWith("NVIDIA_VISIBLE_DEVICES=") &&
          entry !== "NVIDIA_VISIBLE_DEVICES=void")) return false;
    const generic = spec.Resources?.Reservations?.GenericResources;
    return generic === undefined || (Array.isArray(generic) && generic.length === 0);
  } catch {
    return false;
  }
}

