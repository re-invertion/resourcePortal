import { Logger } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import {
  firewallRules,
  GATE_DNAT_CHAIN,
  GATE_FORWARD_CHAIN,
  GATE_SNAT_CHAIN,
  wireGuardSetupCommands,
} from "./gate-runtime.logic";
import type { GateRuntimeConfig } from "./gate-runtime.types";

const logger = new Logger("ResourcePortalGateRuntime");
const interfaceName = process.env.RP_GATE_INTERFACE_NAME ?? "wg0";
const reconcileMs = Math.max(
  1_000,
  Number.parseInt(process.env.RP_GATE_RECONCILE_INTERVAL_MS ?? "5000", 10) ||
    5_000,
);
let stopping = false;

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

function run(command: string, args: string[], allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

function config() {
  const encoded = process.env.RP_GATE_CONFIG_B64;
  if (!encoded) throw new Error("RP_GATE_CONFIG_B64 is required");
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  ) as GateRuntimeConfig;
  if (
    !parsed.gateId ||
    !parsed.peerPublicKey ||
    !parsed.privateKeyPath ||
    !parsed.serverTunnelAddress ||
    !parsed.clientTunnelAddress ||
    !Number.isInteger(parsed.listenPort)
  ) {
    throw new Error("ResourcePortalGate runtime configuration is incomplete");
  }
  return parsed;
}

function ensureChain(table: "filter" | "nat", chain: string) {
  const prefix = table === "nat" ? ["-t", "nat"] : [];
  run("iptables", [...prefix, "-N", chain], true);
  run("iptables", [...prefix, "-F", chain]);
}

function ensureJump(
  table: "filter" | "nat",
  parent: string,
  chain: string,
  extra: string[] = [],
) {
  const prefix = table === "nat" ? ["-t", "nat"] : [];
  const check = run(
    "iptables",
    [...prefix, "-C", parent, ...extra, "-j", chain],
    true,
  );
  if (check.status !== 0) {
    run("iptables", [...prefix, "-I", parent, "1", ...extra, "-j", chain]);
  }
}

function setupFirewall() {
  ensureChain("filter", GATE_FORWARD_CHAIN);
  ensureChain("nat", GATE_DNAT_CHAIN);
  ensureChain("nat", GATE_SNAT_CHAIN);
  ensureJump("filter", "FORWARD", GATE_FORWARD_CHAIN);
  ensureJump("nat", "PREROUTING", GATE_DNAT_CHAIN, ["-i", interfaceName]);
  ensureJump("nat", "POSTROUTING", GATE_SNAT_CHAIN);
}

function resolveAlias(alias: string) {
  const result = run("getent", ["ahostsv4", alias], true);
  if (result.status !== 0) return undefined;
  const first = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value ?? ""));
  return first;
}

function reconcileFirewall(runtime: GateRuntimeConfig) {
  const resolved = new Map<string, string>();
  for (const mapping of runtime.mappings) {
    const address = resolveAlias(mapping.attachmentAlias);
    if (address) resolved.set(mapping.attachmentAlias, address);
  }

  run("iptables", ["-F", GATE_FORWARD_CHAIN]);
  run("iptables", ["-t", "nat", "-F", GATE_DNAT_CHAIN]);
  run("iptables", ["-t", "nat", "-F", GATE_SNAT_CHAIN]);
  const rules = firewallRules(runtime, resolved, interfaceName);
  for (const args of rules.forward) run("iptables", args);
  for (const args of rules.dnat) run("iptables", ["-t", "nat", ...args]);
  for (const args of rules.snat) run("iptables", ["-t", "nat", ...args]);
  return resolved.size;
}

async function main() {
  const runtime = config();
  for (const [command, args, allowFailure] of wireGuardSetupCommands(
    runtime,
    interfaceName,
  )) {
    run(command, [...args], allowFailure);
  }
  const forwarding = run("sysctl", ["-n", "net.ipv4.ip_forward"]);
  if (forwarding.stdout !== "1") {
    throw new Error(
      "ResourcePortalGate requires net.ipv4.ip_forward=1 in its network namespace",
    );
  }
  setupFirewall();
  logger.log(
    `Gate ${runtime.gateId} listening UDP/${runtime.listenPort} mappings=${runtime.mappings.length}`,
  );
  while (!stopping) {
    try {
      const resolved = reconcileFirewall(runtime);
      if (resolved !== runtime.mappings.length) {
        logger.warn(
          `Resolved ${resolved}/${runtime.mappings.length} application targets; waiting for remaining deployments`,
        );
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, reconcileMs));
  }
}

void main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
