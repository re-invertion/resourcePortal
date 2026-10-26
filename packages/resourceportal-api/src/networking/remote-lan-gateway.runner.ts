import { Logger } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { RemoteLanGatewayController } from "./remote-lan-gateway-controller";
import { requireEffectiveCapabilities } from "./runtime-capabilities";

import type { GateRuntimeConfig } from "./gate-runtime.types";

const logger = new Logger("RemoteLanGatewayRuntime");
const WG = "wg0";
function hostAddressCidr(address: string) {
  const host = address.split("/")[0];
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? ""))
    throw new Error("Invalid RP Gate peer tunnel address");
  return host + "/32";
}
let stopping = false;
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

function run(command: string, args: string[], allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 12000 });
  if (result.status !== 0 && !allowFailure)
    throw new Error(command + " operation failed: " + (result.stderr || result.error?.message));
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim() };
}

function runtimeConfig(): GateRuntimeConfig {
  const encoded = process.env.RP_GATE_CONFIG_B64;
  if (!encoded || encoded.length > 200000 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Invalid RP Gate runtime policy");
  const config = JSON.parse(Buffer.from(encoded,"base64").toString("utf8")) as GateRuntimeConfig;
  if (!config.gateId || !config.peerPublicKey || !config.privateKeyPath ||
      !config.serverTunnelAddress || !config.clientTunnelAddress ||
      !Number.isInteger(config.listenPort) || config.listenPort < 1024 ||
      config.listenPort > 65535 || !Array.isArray(config.remoteLanAttachments))
    throw new Error("Incomplete Remote LAN Gateway policy");
  return config;
}

function tasks(serviceName: string): string[] {
  if (!/^rp_[a-zA-Z0-9_]+$/.test(serviceName)) return [];
  const query = run("getent", ["ahostsv4", "tasks." + serviceName], true);
  if (query.status !== 0) return [];
  return [...new Set(query.stdout.split("\n").map(line => line.trim().split(/\s+/)[0])
    .filter((ip): ip is string => Boolean(ip && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip))))];
}

function setupWireguard(config: GateRuntimeConfig) {
  // An L2-only WireGuard underlay has NO customer-LAN routes, broad peer
  // AllowedIPs or namespace IPv4 forwarding. The sole peer is the Gate /32.
  // Swarm provisions namespace sysctls before task startup. /proc/sys is
  // read-only at runtime: verify zero forwarding rather than writing it.
  const forwarding = run("sysctl", ["-n", "net.ipv4.ip_forward"]);
  if (forwarding.stdout !== "0")
    throw new Error("Remote LAN Gateway requires disabled IPv4 forwarding");
  run("ip", ["link", "del", WG], true);
  run("ip", ["link", "add", WG, "type", "wireguard"]);
  run("ip", ["address", "add", config.serverTunnelAddress, "dev", WG]);
  run("wg", ["set", WG, "private-key", config.privateKeyPath,
    "listen-port", String(config.listenPort), "peer", config.peerPublicKey,
    "allowed-ips", hostAddressCidr(config.clientTunnelAddress)]);
  run("ip", ["link", "set", "mtu", "1380", "up", "dev", WG]);
}

async function main() {
  requireEffectiveCapabilities("Remote LAN Gateway", ["NET_ADMIN", "NET_RAW"]);
  const config = runtimeConfig();
  const controller = new RemoteLanGatewayController(run);
  setupWireguard(config);
  logger.log("Remote LAN Gateway tunnel ready for " + config.gateId);
  try {
    while (!stopping) {
      try {
        const known = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
          (entries ?? []).filter(value => value.family === "IPv4")
            .map(value => ({ name, address: value.address })));
        const byService = new Map((config.remoteLanAttachments ?? []).map(item =>
          [item.serviceName, tasks(item.serviceName)]));
        // No arbitrary Site VPN route can grant Ethernet bridging. Revoke
        // previously active bridges on any invalid or ambiguous task state.
        const count = controller.reconcile(config, known, byService,
          process.env.RP_REMOTE_LAN_GATEWAY_ENABLED === "true");
        logger.log("Remote LAN Gateway active attachments=" + count);
      } catch (error) {
        logger.error("Gateway L2 reconcile failed: " + String(error));
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } finally {
    try { controller.stop(); } catch (error) {
      logger.error("Gateway L2 shutdown cleanup failed: " + String(error));
      process.exitCode = 1;
    }
    run("ip", ["link", "delete", WG], true);
  }
}

void main().catch(error => { logger.error(String(error)); process.exitCode = 1; });
