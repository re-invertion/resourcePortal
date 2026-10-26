import { revokeNodeLanState, sameNodeLanTarget, type NodeLanLink, type NodeLanTarget } from "./remote-lan-node-policy";

/** Recovery policy for a DHCP process bound to one verified tenant L2 tunnel.
 *
 * An early udhcpc -n exit is not proof of a permanent network failure. The
 * detached node agent must continue retrying until the RP gateway/L2 tunnel
 * and customer's DHCP server become reachable.
 */
export type DhcpChildState = {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
};

export const DHCP_RESTART_INTERVAL_MS = 20_000;
export const DHCP_PROOF_LOG_INTERVAL_MS = 30_000;

export function dhcpClientStopped(client: DhcpChildState | null): boolean {
  return client === null || client.killed || client.pid === undefined ||
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

/** Reconcile revocation AND grants together, so a dead-client cleanup cannot
 * bypass the bounded DHCP re-attachment delay. Never reset owner validation. */
export function reconcileNodeLanDhcp<T extends {
  target: NodeLanTarget;
  device: string;
  dhcp: (DhcpChildState & { pid?: number }) | null;
}>(
  managed: Map<string, T>,
  desired: ReadonlyMap<string, NodeLanTarget>,
  pids: readonly number[],
  detach: (entry: T) => void,
  links: (pid: number) => readonly NodeLanLink[],
  remove: (pid: number, ifname: string) => void,
  attach: (target: NodeLanTarget) => T,
  restartAt: Map<string, number>,
  nowMs: number,
  onStopped: (attachmentId: string) => void,
  transportMatches?: (entry: T) => boolean,
): void {
  revokeNodeLanState(managed, desired, pids, (entry) => {
    const key = entry.target.id + ":" + entry.target.attachment.attachmentId;
    const updated = desired.get(key);
    const stopped = updated !== undefined &&
      sameNodeLanTarget(entry.target, updated) &&
      (entry.target.attachment.addressMode ?? "DHCP") === "DHCP" &&
      dhcpClientStopped(entry.dhcp);
    // Only record the retry deadline after verified, successful cleanup.
    detach(entry);
    if (stopped) {
      restartAt.set(key, nowMs);
      onStopped(entry.target.attachment.attachmentId);
    }
  }, links, remove, transportMatches);
  for (const [key, target] of desired) {
    if (managed.has(key)) continue;
    const last = restartAt.get(key);
    if ((target.attachment.addressMode ?? "DHCP") === "DHCP" &&
        last !== undefined &&
        !shouldRestartDhcp("DHCP", null, last, nowMs)) continue;
    managed.set(key, attach(target));
  }
}
