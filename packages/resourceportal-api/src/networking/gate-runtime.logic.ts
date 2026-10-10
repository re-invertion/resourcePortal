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

  // RP-to-LAN is opt-in. Source addresses are restricted to attached
  // RP overlays, destinations to Gate-reported LAN CIDRs.
  if (config.allowRpToLan === true) {
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
