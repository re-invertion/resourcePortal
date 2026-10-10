import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicVpnFirewallRestore } from "./atomic-vpn-firewall";
import {
  DEVICE_VPN_DNAT_CHAIN,
  DEVICE_VPN_FORWARD_CHAIN,
  DEVICE_VPN_SNAT_CHAIN,
  deviceVpnFirewallRules,
  deviceVpnWireGuardSetupCommands,
} from "./device-vpn-runtime.logic";
import type { DeviceVpnRuntimeConfig } from "./device-vpn-runtime.types";

const logger = new Logger("DeviceVpnRuntime");
const interfaceName = process.env.RP_DEVICE_VPN_INTERFACE_NAME ?? "wg0";
const reconcileMs = Math.max(
  1_000,
  Number.parseInt(
    process.env.RP_DEVICE_VPN_RECONCILE_INTERVAL_MS ?? "5000",
    10,
  ) || 5_000,
);
const heartbeatMs = Math.max(
  10_000,
  Number.parseInt(
    process.env.RP_DEVICE_VPN_HEARTBEAT_INTERVAL_MS ?? "30000",
    10,
  ) || 30_000,
);
let stopping = false;

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

function run(command: string, args: string[], allowFailure = false, input?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
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
  const encoded = process.env.RP_DEVICE_VPN_CONFIG_B64;
  if (!encoded) throw new Error("RP_DEVICE_VPN_CONFIG_B64 is required");
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  ) as DeviceVpnRuntimeConfig;
  if (
    !parsed.gatewayId ||
    !parsed.privateKeyPath ||
    !parsed.runtimeTokenPath ||
    !parsed.heartbeatUrl ||
    !parsed.serverTunnelAddress ||
    !Number.isInteger(parsed.listenPort) ||
    !Array.isArray(parsed.peers) ||
    !Array.isArray(parsed.mappings)
  ) {
    throw new Error("Device VPN runtime configuration is incomplete");
  }
  return parsed;
}

function ensureChain(table: "filter" | "nat", chain: string) {
  const prefix = table === "nat" ? ["-t", "nat"] : [];
  run("iptables", [...prefix, "-N", chain], true);
  // Never flush a live chain before the replacement rules are committed.
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
  ensureChain("filter", DEVICE_VPN_FORWARD_CHAIN);
  ensureChain("nat", DEVICE_VPN_DNAT_CHAIN);
  ensureChain("nat", DEVICE_VPN_SNAT_CHAIN);
  ensureJump("filter", "FORWARD", DEVICE_VPN_FORWARD_CHAIN);
  ensureJump("nat", "PREROUTING", DEVICE_VPN_DNAT_CHAIN, [
    "-i",
    interfaceName,
  ]);
  ensureJump("nat", "POSTROUTING", DEVICE_VPN_SNAT_CHAIN);
}

function resolveAlias(alias: string) {
  const result = run("getent", ["ahostsv4", alias], true);
  if (result.status !== 0) return undefined;
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value ?? ""));
}

function reconcileFirewall(runtime: DeviceVpnRuntimeConfig) {
  const resolved = new Map<string, string>();
  for (const mapping of runtime.mappings) {
    const address = resolveAlias(mapping.attachmentAlias);
    if (address) resolved.set(mapping.attachmentAlias, address);
  }

  const rules = deviceVpnFirewallRules(runtime, resolved, interfaceName);
  const script = atomicVpnFirewallRestore({
    forwardChain: DEVICE_VPN_FORWARD_CHAIN,
    dnatChain: DEVICE_VPN_DNAT_CHAIN,
    snatChain: DEVICE_VPN_SNAT_CHAIN,
    ...rules,
  });
  run("iptables-restore", ["-w", "5", "--noflush"], false, script);
  return resolved.size;
}

function peerHandshakes() {
  const result = run(
    "wg",
    ["show", interfaceName, "latest-handshakes"],
    true,
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .flatMap(([publicKey, timestamp]) => {
      const latestHandshake = Number.parseInt(timestamp ?? "0", 10);
      return publicKey && Number.isFinite(latestHandshake)
        ? [{ publicKey, latestHandshake }]
        : [];
    });
}

async function heartbeat(runtime: DeviceVpnRuntimeConfig) {
  const token = readFileSync(runtime.runtimeTokenPath, "utf8").trim();
  if (!token) throw new Error("Device VPN runtime token is empty");
  const response = await fetch(runtime.heartbeatUrl, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ peers: peerHandshakes() }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Device VPN heartbeat failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
}

async function main() {
  const runtime = config();
  for (const [command, args, allowFailure] of deviceVpnWireGuardSetupCommands(
    runtime,
    interfaceName,
  )) {
    run(command, [...args], allowFailure);
  }
  const forwarding = run("sysctl", ["-n", "net.ipv4.ip_forward"]);
  if (forwarding.stdout !== "1") {
    throw new Error(
      "Device VPN requires net.ipv4.ip_forward=1 in its network namespace",
    );
  }
  setupFirewall();
  logger.log(
    `Device VPN gateway ${runtime.gatewayId} listening UDP/${runtime.listenPort} peers=${runtime.peers.length} mappings=${runtime.mappings.length}`,
  );

  let nextHeartbeat = 0;
  let heartbeatInFlight: Promise<void> | undefined;
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

    if (Date.now() >= nextHeartbeat && !heartbeatInFlight) {
      nextHeartbeat = Date.now() + heartbeatMs;
      // Telemetry cannot postpone safety-critical firewall reconciliation.
      heartbeatInFlight = heartbeat(runtime)
        .catch((error) => logger.warn(error instanceof Error ? error.message : String(error)))
        .finally(() => { heartbeatInFlight = undefined; });
    }
    await new Promise((resolve) => setTimeout(resolve, reconcileMs));
  }
}

void main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});