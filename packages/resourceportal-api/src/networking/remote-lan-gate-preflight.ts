/**
 * Fail-closed preflight for a physical or VLAN handoff to a customer's LAN.
 * Linux bridging a Gate management NIC without moving its IP can sever the
 * control tunnel. A dedicated unnumbered interface must be used instead.
 * Inputs are read-only snapshots of ip -j link, ip -j addr and ip -j route.
 */
export type IpLinkSnapshot = {
  ifname?: string;
  ifalias?: string;
  ifindex?: number;
  operstate?: string;
  link_type?: string;
  master?: string;
  linkinfo?: { info_kind?: string };
};
export type IpAddressSnapshot = {
  ifname?: string;
  addr_info?: Array<{ family?: string; local?: string }>;
};
export type IpRouteSnapshot = { dst?: string; dev?: string; gateway?: string };
const devicePattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/;

export function assertSafeGateLanInterface(
  device: string,
  links: readonly IpLinkSnapshot[],
  addresses: readonly IpAddressSnapshot[],
  routes: readonly IpRouteSnapshot[],
): void {
  if (!devicePattern.test(device) || ["lo", "docker0", "wg0", "rp-gate"].includes(device))
    throw new Error("Invalid LAN handoff interface");
  const link = links.find(l => l.ifname === device);
  if (!link || !Number.isSafeInteger(link.ifindex) || link.ifindex! < 1)
    throw new Error("Selected interface does not exist");
  if (link.master) throw new Error("Selected interface is already enslaved to a network master");
  if (link.operstate !== "UP") throw new Error("Selected interface link is not up");
  const kind = link.linkinfo?.info_kind;
  if (kind && kind !== "vlan") throw new Error("Only dedicated physical or VLAN Ethernet can be bridged");
  if (link.link_type !== "ether") throw new Error("Selected interface is not Ethernet");
  const address = addresses.find(a => a.ifname === device);
  if (address?.addr_info?.some(a => a.family === "inet" || a.family === "inet6"))
    throw new Error("Selected interface has host IPs; management link must never be bridged");
  if (routes.some(r => r.dev === device && (r.dst === "default" || r.dst === "0.0.0.0/0" || r.dst === "::/0")))
    throw new Error("Selected interface carries the management default route");
  if (links.some(l => l.ifname !== device && l.master === device))
    throw new Error("Selected interface is already a network master");
}
