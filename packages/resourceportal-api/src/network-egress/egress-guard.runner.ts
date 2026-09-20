import { spawn, type ChildProcess } from "node:child_process";
import { Logger } from "@nestjs/common";
import {
  decodeEgressPolicy,
  egressPolicyDigest,
  firewallRulesForWorkloads,
  internalPortFirewallRules,
  tenantWorkloads,
  type DockerContainerInspect,
  type DockerGatewayNetworkInspect,
} from "./egress-guard.logic";
import { EGRESS_POLICY_ENV } from "./network-egress.constants";

const logger = new Logger("NetworkEgressGuard");
const FORWARD_CHAIN = "RP-TENANT-EGRESS";
const HOST_CHAIN = "RP-TENANT-HOST";
const INTERNAL_PORT_CHAIN = "RP-TENANT-INTERNAL-PORTS";
const reconcileMs = readPositiveInt(
  process.env.EGRESS_GUARD_RECONCILE_INTERVAL_MS,
  2_000,
);
let stopping = false;
let lastDigest = "";
let eventProcess: ChildProcess | undefined;
let wakeReconcile: (() => void) | undefined;

process.once("SIGTERM", () => {
  stopping = true;
  wakeReconcile?.();
  eventProcess?.kill("SIGTERM");
});
process.once("SIGINT", () => {
  stopping = true;
  wakeReconcile?.();
  eventProcess?.kill("SIGTERM");
});

async function main() {
  logger.log(
    `Starting egress guard reconciliation every ${reconcileMs}ms with Docker event wakeups`,
  );
  startDockerEventWatcher();
  let consecutiveFailures = 0;
  while (!stopping) {
    try {
      await reconcile();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.error(error instanceof Error ? error.message : String(error));
      if (consecutiveFailures >= 3) {
        throw new Error(
          `Egress enforcement failed ${consecutiveFailures} consecutive times; exiting for Swarm restart`,
          { cause: error },
        );
      }
    }
    if (!stopping) await waitForReconcileWakeup(reconcileMs);
  }
  logger.log("Stopping egress guard");
}

async function reconcile() {
  const encodedPolicy = process.env[EGRESS_POLICY_ENV];
  if (!encodedPolicy && (await hasExistingPolicyState())) {
    // A normal `docker stack deploy` can temporarily omit the worker-managed
    // snapshot. Preserve the last applied host firewall state until the worker
    // reattaches the authoritative policy. On a fresh node no RP chains exist,
    // so the fail-closed default policy is still applied immediately.
    return;
  }
  const policy = decodeEgressPolicy(encodedPolicy);
  const [containersRaw, gatewayRaw] = await Promise.all([
    dockerJson(["inspect", ...await containerIds()]),
    dockerJson(["network", "inspect", "docker_gwbridge"]),
  ]);
  const containers = Array.isArray(containersRaw)
    ? (containersRaw as DockerContainerInspect[])
    : [];
  const gateway = Array.isArray(gatewayRaw)
    ? ((gatewayRaw[0] ?? {}) as DockerGatewayNetworkInspect)
    : {};
  const workloads = tenantWorkloads(containers, gateway);
  const ipv4Rules = firewallRulesForWorkloads(policy, workloads, 4);
  const ipv6Rules = firewallRulesForWorkloads(policy, workloads, 6);
  const ipv4InternalPortRules = internalPortFirewallRules(policy, workloads, 4);
  const ipv6InternalPortRules = internalPortFirewallRules(policy, workloads, 6);
  const digest = egressPolicyDigest(policy) +
    `:${workloads
      .map(
        (item) =>
          `${item.containerId}:${item.ipv4 ?? ""}:${item.ipv6 ?? ""}:${item.internalPortExposures
            .map((exposure) => `${exposure.protocol}/${exposure.publishedPort}`)
            .join("+")}`,
      )
      .join(",")}`;
  if (digest === lastDigest) return;

  await applyFamily("iptables", policy.enabled, ipv4Rules);
  await applyInternalPortFamily("iptables", ipv4InternalPortRules);
  if (await commandExists("ip6tables")) {
    const ipv6ForwardingAvailable = await chainExists(
      "ip6tables",
      "DOCKER-USER",
    );
    if (ipv6ForwardingAvailable) {
      await applyFamily("ip6tables", policy.enabled, ipv6Rules);
      await applyInternalPortFamily("ip6tables", ipv6InternalPortRules);
    } else if (ipv6Rules.length > 0) {
      throw new Error(
        "Tenant IPv6 workload detected but Docker IPv6 DOCKER-USER chain is unavailable",
      );
    }
  }
  lastDigest = digest;
  logger.log(
    `Applied network policy revision=${policy.revision} enabled=${policy.enabled} workloads=${workloads.length} rules=${policy.rules.length} internalPorts=${ipv4InternalPortRules.filter((rule) => rule.includes("REJECT")).length}`,
  );
}

async function applyFamily(
  binary: "iptables" | "ip6tables",
  enabled: boolean,
  rules: string[][],
) {
  await ensureChain(binary, FORWARD_CHAIN);
  await ensureChain(binary, HOST_CHAIN);

  if (!enabled) {
    await removeAllJumps(binary, "DOCKER-USER", FORWARD_CHAIN);
    await removeAllJumps(binary, "INPUT", HOST_CHAIN);
    await run(binary, ["-w", "5", "-F", FORWARD_CHAIN]);
    await run(binary, ["-w", "5", "-F", HOST_CHAIN]);
    return;
  }

  await ensureJump(binary, "DOCKER-USER", FORWARD_CHAIN);
  await ensureJump(binary, "INPUT", HOST_CHAIN);
  await run(binary, ["-w", "5", "-F", FORWARD_CHAIN]);
  await run(binary, ["-w", "5", "-F", HOST_CHAIN]);
  for (const rule of rules) {
    await run(binary, ["-w", "5", "-A", FORWARD_CHAIN, ...rule]);
    await run(binary, ["-w", "5", "-A", HOST_CHAIN, ...rule]);
  }
}

async function applyInternalPortFamily(
  binary: "iptables" | "ip6tables",
  rules: string[][],
) {
  await ensureChain(binary, INTERNAL_PORT_CHAIN);
  if (rules.length === 0) {
    await removeAllJumps(binary, "DOCKER-USER", INTERNAL_PORT_CHAIN);
    await run(binary, ["-w", "5", "-F", INTERNAL_PORT_CHAIN]);
    return;
  }

  await ensureJump(binary, "DOCKER-USER", INTERNAL_PORT_CHAIN);
  await run(binary, ["-w", "5", "-F", INTERNAL_PORT_CHAIN]);
  for (const rule of rules) {
    await run(binary, ["-w", "5", "-A", INTERNAL_PORT_CHAIN, ...rule]);
  }
}

async function hasExistingPolicyState() {
  const [forwardChain, hostChain, forwardJump, hostJump] = await Promise.all([
    chainExists("iptables", FORWARD_CHAIN),
    chainExists("iptables", HOST_CHAIN),
    jumpExists("iptables", "DOCKER-USER", FORWARD_CHAIN),
    jumpExists("iptables", "INPUT", HOST_CHAIN),
  ]);
  // Both jumps present means the last known policy was enabled. Both absent
  // means Platform Admin deliberately disabled enforcement. A partial state is
  // treated as invalid and rebuilt from the fail-closed default.
  return forwardChain && hostChain && forwardJump === hostJump;
}

async function jumpExists(binary: string, parent: string, child: string) {
  const result = await run(
    binary,
    ["-w", "5", "-C", parent, "-j", child],
    true,
  );
  return result.exitCode === 0;
}

function startDockerEventWatcher() {
  const child = spawn(
    "docker",
    [
      "events",
      "--filter",
      "type=container",
      "--filter",
      "event=start",
      "--filter",
      "event=die",
      "--filter",
      "event=destroy",
      "--format",
      "{{json .}}",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  eventProcess = child;
  child.stdout.on("data", () => wakeReconcile?.());
  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) logger.warn(`Docker event watcher: ${message}`);
  });
  child.on("error", (error) => {
    logger.warn(`Docker event watcher unavailable: ${error.message}`);
  });
  child.on("close", (code) => {
    eventProcess = undefined;
    if (!stopping && code !== 0) {
      logger.warn(
        `Docker event watcher stopped with exit ${code ?? "unknown"}; polling remains active`,
      );
    }
  });
}

function waitForReconcileWakeup(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wakeReconcile === finish) wakeReconcile = undefined;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    wakeReconcile = finish;
  });
}

async function chainExists(binary: string, chain: string) {
  const result = await run(binary, ["-w", "5", "-S", chain], true);
  return result.exitCode === 0;
}

async function ensureChain(binary: string, chain: string) {
  const exists = await run(binary, ["-w", "5", "-S", chain], true);
  if (exists.exitCode === 0) return;
  await run(binary, ["-w", "5", "-N", chain]);
}

async function ensureJump(binary: string, parent: string, child: string) {
  const exists = await run(
    binary,
    ["-w", "5", "-C", parent, "-j", child],
    true,
  );
  if (exists.exitCode === 0) return;
  await run(binary, ["-w", "5", "-I", parent, "1", "-j", child]);
}

async function removeAllJumps(binary: string, parent: string, child: string) {
  while (true) {
    const exists = await run(
      binary,
      ["-w", "5", "-C", parent, "-j", child],
      true,
    );
    if (exists.exitCode !== 0) return;
    await run(binary, ["-w", "5", "-D", parent, "-j", child]);
  }
}

async function containerIds() {
  const result = await run(
    "docker",
    ["ps", "--no-trunc", "--format", "{{.ID}}"],
  );
  return result.stdout.split(/\s+/).filter(Boolean);
}

async function dockerJson(args: string[]) {
  if (args[0] === "inspect" && args.length === 1) return [];
  const result = await run("docker", args);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`Unable to parse docker ${args.join(" ")} JSON output`);
  }
}

async function commandExists(command: string) {
  const result = await run("sh", ["-c", `command -v ${command}`], true);
  return result.exitCode === 0;
}

async function run(command: string, args: string[], allowFailure = false) {
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({ exitCode: 127, stdout: "", stderr: error.message }),
    );
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
  });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : fallback;
}


void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
