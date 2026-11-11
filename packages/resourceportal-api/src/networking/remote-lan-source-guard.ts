import { containsIpv4, parseIpv4Cidr } from "./network-addressing";

/** Source identity is a worker-verified lease, never a tenant-provided address. */
export type LanAddressGrant = {
  lanCidr?: string;
  addressMode?: string;
  staticAddress?: string | null;
  status?: string;
  verifiedAddress?: string | null;
  leaseExpiresAt?: string | null;
  authorizationExpiresAt?: string | null;
  authorizationRequired?: boolean;
};
export type BoundLanSource = { ip: string; timeoutSeconds?: number };

export function boundLanSource(grant: LanAddressGrant, now = Date.now()): BoundLanSource | null {
  if (!Number.isFinite(now)) return null;
  const cidr = grant.lanCidr ? parseIpv4Cidr(grant.lanCidr) : null;
  if (!cidr || cidr.prefix < 16 || cidr.prefix > 30) return null;
  let ip: string | undefined;
  let timeoutSeconds: number | undefined;
  if (grant.addressMode === "Static") {
    if (!["Provisioning", "Active"].includes(grant.status ?? "")) return null;
    const address = grant.staticAddress ? parseIpv4Cidr(grant.staticAddress) : null;
    if (!address || address.normalized !== cidr.normalized) return null;
    ip = grant.staticAddress!.split("/")[0];
    const authExpiry = grant.authorizationExpiresAt ?
      Date.parse(grant.authorizationExpiresAt) : NaN;
    if (grant.authorizationRequired) {
      if (!Number.isFinite(authExpiry) || authExpiry <= now + 1_000 ||
          authExpiry > now + 600_000) return null;
      timeoutSeconds = Math.floor((authExpiry - now) / 1000);
    }
  } else if (grant.addressMode === "DHCP" && grant.status === "Active") {
    const expiry = grant.leaseExpiresAt ? Date.parse(grant.leaseExpiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= now + 1000 ||
        expiry > now + 90 * 86400_000) return null;
    ip = grant.verifiedAddress ?? undefined;
    timeoutSeconds = Math.floor((expiry - now) / 1000);
  }
  const host = ip ? parseIpv4Cidr(ip + "/32") : null;
  if (!ip || !host || !containsIpv4(cidr, ip) ||
      host.network === cidr.network || host.network === cidr.broadcast)
    return null;
  return timeoutSeconds === undefined ? { ip } : { ip, timeoutSeconds };
}

/** Build bridge-family ingress filters. The hook is installed before the port joins any bridge.
 * DHCP and RFC 5227 ARP probes are bootstrap-only; all other IPv4/ARP traffic
 * requires the exact verified source IP. Timed sets expire in the kernel even
 * when the control plane or Gate agent is no longer reconciling.
 */
export function lanIngressRules(
  table: string, chain: string, iface: string, mac: string,
  source: BoundLanSource | null,
): ReadonlyArray<readonly ["nft", readonly string[]]> {
  const prefix = ["add", "rule", "bridge", table, chain, "iifname", iface];
  const rules: Array<readonly ["nft", readonly string[]]> = [];
  const add = (...tail: string[]) => rules.push(["nft", [...prefix, ...tail]]);
  const sourceSet = "rpip_" + chain.slice(3);
  // A stable, always-present IPv4 set allows an authorized proof/lease to
  // change WITHOUT detaching the GRETAP transport or replacing Swarm tasks.
  // An empty set drops all non-bootstrap ARP/IPv4. Kernel timeouts continue
  // enforcing lease expiry even if control-plane reconciliation stops.
  rules.push(["nft", ["add", "set", "bridge", table, sourceSet,
    "{", "type", "ipv4_addr", ";", "flags", "timeout", ";", "}"]]);
  if (source) {
    rules.push(["nft", ["add", "element", "bridge", table, sourceSet,
      "{", source.ip, ...(source.timeoutSeconds === undefined
        ? [] : ["timeout", source.timeoutSeconds + "s"]), "}"]]);
  }
  add("ether", "saddr", "!=", mac.toLowerCase(), "drop");
  add("ether", "type", "vlan", "drop");
  add("ether", "type", "0x88a8", "drop");
  add("ether", "type", "ip6", "drop");
  add("ether", "daddr", "01:80:c2:00:00:00", "drop");
  add("ether", "type", "ip", "udp", "sport", "67", "drop");
  add("ether", "type", "arp", "arp", "saddr", "ether", "!=", mac.toLowerCase(), "drop");
  add("ether", "type", "arp", "arp", "saddr", "ip", "0.0.0.0",
    "arp", "operation", "request", "accept");
  add("ether", "type", "arp", "arp", "saddr", "ip", "0.0.0.0", "drop");
  add("ether", "type", "ip", "ip", "saddr", "0.0.0.0", "udp", "sport", "68",
    "udp", "dport", "67", "accept");
  add("ether", "type", "arp", "arp", "saddr", "ip", "!=", "@" + sourceSet, "drop");
  add("ether", "type", "ip", "ip", "saddr", "!=", "@" + sourceSet, "drop");
  add("ether", "type", "!=", "{", "arp", ",", "ip", "}", "drop");
  return rules;
}
