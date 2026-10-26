/** Recovery policy for a DHCP process bound to one verified tenant L2 tunnel.
 *
 * An early udhcpc -n exit is not proof of a permanent network failure. The
 * detached node agent must continue retrying until the RP gateway/L2 tunnel
 * and customer's DHCP server become reachable.
 */
export type DhcpChildState = {
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
};

export const DHCP_RESTART_INTERVAL_MS = 20_000;
export const DHCP_PROOF_LOG_INTERVAL_MS = 30_000;

export function dhcpClientStopped(client: DhcpChildState | null): boolean {
  return client === null || client.killed ||
    client.exitCode !== null || client.signalCode !== null;
}

export function shouldRestartDhcp(
  mode: "DHCP" | "Static",
  client: DhcpChildState | null,
  lastRestartAtMs: number,
  nowMs: number,
): boolean {
  if (mode !== "DHCP" || !dhcpClientStopped(client)) return false;
  return Number.isFinite(nowMs) && nowMs >= 0 &&
    Number.isFinite(lastRestartAtMs) &&
    nowMs - lastRestartAtMs >= DHCP_RESTART_INTERVAL_MS;
}
