import { containsIpv4, parseIpv4Cidr } from "./network-addressing";
import type { GateRuntimeConfig } from "./gate-runtime.types";

export const GATE_FORWARD_CHAIN = "RP-GATE-FWD";
export const GATE_DNAT_CHAIN = "RP-GATE-DNAT";
export const GATE_SNAT_CHAIN = "RP-GATE-SNAT";

export function hostAddressCidr(value: string) {
  const address = value.split("/")[0]?.trim();
  if (!address) throw new Error("Invalid tunnel address");
  return `${address}/32`;
}

export function wireGuardSetupCommands(
  config: GateRuntimeConfig,
  interfaceName = "wg0",
) {
  return [
    ["ip", ["link", "del", interfaceName], true] as const,
    ["ip", ["link", "add", interfaceName, "type", "wireguard"], false] as const,
    [
      "ip",
      ["address", "add", config.serverTunnelAddress, "dev", interfaceName],
      false,
    ] as const,
    [
      "wg",
      [
        "set",
        interfaceName,
        "private-key",
        config.privateKeyPath,
        "listen-port",
        String(config.listenPort),
        "peer",
        config.peerPublicKey,
        "allowed-ips",
        [hostAddressCidr(config.clientTunnelAddress), ...config.peerLanCidrs].join(","),
      ],
      false,
    ] as const,
    [
      "ip",
      ["link", "set", "mtu", "1380", "up", "dev", interfaceName],
      false,
    ] as const,
    ...config.peerLanCidrs.map(
      (cidr) =>
        [
          "ip",
          ["route", "replace", cidr, "dev", interfaceName],
          false,
        ] as const,
    ),
  ];
}

export function firewallRules(
  config: GateRuntimeConfig,
  resolved: Map<string, string>,
  interfaceName = "wg0",
  sourceInterfaces: Map<string, string> = new Map(),
  taskAddresses: Map<string, string[]> = new Map(),
) {
  const forward: string[][] = [
    ["-A", GATE_FORWARD_CHAIN, "-i", interfaceName, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-A", GATE_FORWARD_CHAIN, "-o", interfaceName, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
  ];
  const dnat: string[][] = [];
  const snat: string[][] = [];
  const sourceCidrs = [
    hostAddressCidr(config.clientTunnelAddress),
    ...config.peerLanCidrs,
  ];

  for (const mapping of config.allowLanToRp === false ? [] : config.mappings) {
    const target = resolved.get(mapping.attachmentAlias);
    if (!target) continue;
    dnat.push([
      "-A",
      GATE_DNAT_CHAIN,
      "-i",
      interfaceName,
      "-d",
      mapping.stableAddress,
      "-j",
      "DNAT",
      "--to-destination",
      target,
    ]);
    for (const cidr of sourceCidrs) {
      forward.push([
        "-A", GATE_FORWARD_CHAIN, "-i", interfaceName, "-s", cidr,
        "-d", target, "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT",
      ]);
    }
    for (const sourceCidr of sourceCidrs) {
      snat.push([
        "-A",
        GATE_SNAT_CHAIN,
        "-s",
        sourceCidr,
        "-d",
        mapping.overlayCidr,
        "-j",
        "MASQUERADE",
      ]);
    }
  }

  // Per-application egress never authorizes an entire overlay CIDR.
  if (config.allowRpToLan === true && config.applicationAccessMode === "PerApplication") {
    const knownAliases = new Set(config.mappings.map((mapping) => mapping.attachmentAlias));
    for (const policy of config.applicationLanRules ?? []) {
      if (!knownAliases.has(policy.attachmentAlias)) throw new Error("Unknown Gate application attachment");
      const destination = parseIpv4Cidr(policy.destinationCidr);
      if (!destination || !config.peerLanCidrs.some((lan) => {
        const range = parseIpv4Cidr(lan);
        return range && destination.network >= range.network && destination.broadcast <= range.broadcast;
      }) || !["tcp", "udp"].includes(policy.protocol) ||
        !Number.isInteger(policy.port) || policy.port < 1 || policy.port > 65535) {
        throw new Error("Invalid application LAN policy");
      }
      const mapping = config.mappings.find(item => item.attachmentAlias === policy.attachmentAlias);
      const inInterface = mapping ? sourceInterfaces.get(mapping.overlayCidr) : undefined;
      const overlay = mapping ? parseIpv4Cidr(mapping.overlayCidr) : undefined;
      if (!inInterface || !overlay) continue;
      if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(inInterface)) throw new Error("Invalid network interface");
      const serverSource = hostAddressCidr(config.serverTunnelAddress).split("/")[0];
      for (const source of taskAddresses.get(policy.attachmentAlias) ?? []) {
        if (!containsIpv4(overlay, source)) continue;
        const match = [
          "-s", source, "-d", destination.normalized,
          "-p", policy.protocol, "--dport", String(policy.port),
        ];
        forward.push([
          "-A", GATE_FORWARD_CHAIN, "-i", inInterface, "-o", interfaceName, ...match,
          "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT",
        ]);
        snat.push([
          "-A", GATE_SNAT_CHAIN, "-o", interfaceName, ...match,
          "-j", "SNAT", "--to-source", serverSource,
        ]);
      }
    }
  }
  // RP-to-LAN is opt-in. Source addresses are restricted to attached
  // RP overlays, destinations to Gate-reported LAN CIDRs.
  if (config.allowRpToLan === true && config.applicationAccessMode !== "PerApplication") {
    const overlays = new Set(config.rpOverlayCidrs ?? config.mappings.map((m) => m.overlayCidr));
    const serverTunnelSource = hostAddressCidr(config.serverTunnelAddress).split("/")[0];
    for (const overlay of overlays) {
      for (const lan of config.peerLanCidrs) {
        forward.push([
          "-A", GATE_FORWARD_CHAIN, "-o", interfaceName,
          "-s", overlay, "-d", lan, "-m", "conntrack",
          "--ctstate", "NEW", "-j", "ACCEPT",
        ]);
        snat.push([
          "-A", GATE_SNAT_CHAIN, "-o", interfaceName,
          "-s", overlay, "-d", lan,
          "-j", "SNAT", "--to-source", serverTunnelSource,
        ]);
      }
    }
  }
  forward.push([
    "-A",
    GATE_FORWARD_CHAIN,
    "-i",
    interfaceName,
    "-j",
    "REJECT",
  ]);
  forward.push([
    "-A",
    GATE_FORWARD_CHAIN,
    "-o",
    interfaceName,
    "-j",
    "REJECT",
  ]);
  return { forward, dnat, snat };
}
