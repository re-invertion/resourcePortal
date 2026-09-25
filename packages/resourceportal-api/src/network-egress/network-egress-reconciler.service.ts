import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { encodeEgressPolicy, egressPolicyDigest } from "./egress-guard.logic";
import {
  EGRESS_GUARD_SERVICE_SUFFIX,
  EGRESS_POLICY_ENV,
} from "./network-egress.constants";
import { NetworkEgressService } from "./network-egress.service";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class NetworkEgressReconcilerService {
  constructor(
    private readonly egress: NetworkEgressService,
    private readonly config: ConfigService,
  ) {}

  async reconcile() {
    const policy = await this.egress.policySnapshot();
    const encoded = encodeEgressPolicy(policy);
    const serviceName = this.serviceName();
    const inspect = await this.runDocker([
      "service",
      "inspect",
      serviceName,
      "--format",
      "{{json .Spec.TaskTemplate.ContainerSpec.Env}}",
    ]);
    if (inspect.exitCode !== 0) {
      throw new Error(
        inspect.stderr ||
          inspect.stdout ||
          `Unable to inspect ${serviceName}`,
      );
    }

    let env: string[] = [];
    try {
      const parsed = JSON.parse(inspect.stdout || "[]") as unknown;
      if (Array.isArray(parsed)) {
        env = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      throw new Error(`Unable to parse ${serviceName} environment`);
    }
    const prefix = `${EGRESS_POLICY_ENV}=`;
    const current = env.find((item) => item.startsWith(prefix));
    if (current === `${prefix}${encoded}`) {
      return {
        changed: false,
        revision: policy.revision,
        enabled: policy.enabled,
        digest: egressPolicyDigest(policy),
      };
    }

    const args = ["service", "update"];
    if (current) args.push("--env-rm", EGRESS_POLICY_ENV);
    args.push("--env-add", `${EGRESS_POLICY_ENV}=${encoded}`, serviceName);
    const update = await this.runDocker(args);
    if (update.exitCode !== 0) {
      throw new Error(
        update.stderr ||
          update.stdout ||
          `Unable to update ${serviceName} egress policy`,
      );
    }
    return {
      changed: true,
      revision: policy.revision,
      enabled: policy.enabled,
      digest: egressPolicyDigest(policy),
    };
  }

  private serviceName() {
    return this.config.get<string>(
      "EGRESS_GUARD_SERVICE_NAME",
      `resourceportal-control-plane_${EGRESS_GUARD_SERVICE_SUFFIX}`,
    );
  }

  protected runDocker(args: string[]) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const fullArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      ...args,
    ];
    const timeoutMs = Number.parseInt(
      this.config.get<string>("EGRESS_POLICY_DOCKER_TIMEOUT_MS", "120000"),
      10,
    );
    return new Promise<CommandResult>((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) child.kill("SIGTERM");
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ exitCode: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: signal ? 124 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: signal
            ? `docker command terminated by ${signal}`
            : Buffer.concat(stderr).toString("utf8").trim(),
        });
      });
    });
  }
}
