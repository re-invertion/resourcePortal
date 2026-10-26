import type { GateRuntimeConfig } from "./gate-runtime.types";

/** Docker Swarm applies a container-network-namespace sysctl at service/task
 * creation time. /proc/sys is read-only inside a Swarm task: only verify the
 * exact isolated value here, never modify the host or runtime namespace.
 */
export type GatewayCommandResult = { status: number; stdout: string; stderr: string };
export type GatewayCommand = (command: string, args: string[], allowFailure?: boolean) => GatewayCommandResult;
const WG = "wg0";

function peerHostCidr(address: string) {
  const host = address.split("/")[0];
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? ""))
    throw new Error("Invalid RP Gate peer tunnel address");
  return host + "/32";
}

export function setupRemoteLanGateway(config: GateRuntimeConfig, run: GatewayCommand): void {
  // A wrong forwarding value cannot become a successful L2/Ready runtime,
  // even if a stale or misconfigured Swarm service has the required caps.
  const observed = run("sysctl", ["-n", "net.ipv4.ip_forward"]);
  if (observed.stdout !== "0")
    throw new Error("Remote LAN Gateway requires net.ipv4.ip_forward=0 in its own network namespace");
  run("ip", ["link", "del", WG], true);
  run("ip", ["link", "add", WG, "type", "wireguard"]);
  run("ip", ["address", "add", config.serverTunnelAddress, "dev", WG]);
  run("wg", ["set", WG, "private-key", config.privateKeyPath,
    "listen-port", String(config.listenPort), "peer", config.peerPublicKey,
    "allowed-ips", peerHostCidr(config.clientTunnelAddress)]);
  run("ip", ["link", "set", "mtu", "1380", "up", "dev", WG]);
}
