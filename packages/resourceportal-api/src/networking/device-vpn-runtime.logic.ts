import type { DeviceVpnRuntimeConfig } from "./device-vpn-runtime.types";

export const DEVICE_VPN_FORWARD_CHAIN = "RP-DVPN-FWD";
export const DEVICE_VPN_DNAT_CHAIN = "RP-DVPN-DNAT";
export const DEVICE_VPN_SNAT_CHAIN = "RP-DVPN-SNAT";

export function deviceVpnHostCidr(value: string) {
  const address = value.split("/")[0]?.trim();
  if (!address) throw new Error("Invalid Device VPN address");
  return `${address}/32`;
}

export function deviceVpnWireGuardSetupCommands(
  config: DeviceVpnRuntimeConfig,
  interfaceName = "wg0",
) {
  const commands: Array<readonly [string, readonly string[], boolean]> = [
    ["ip", ["link", "del", interfaceName], true],
    ["ip", ["link", "add", interfaceName, "type", "wireguard"], false],
    [
      "ip",
      ["address", "add", config.serverTunnelAddress, "dev", interfaceName],
      false,
    ],
    [
      "wg",
      [
        "set",
        interfaceName,
        "private-key",
        config.privateKeyPath,
        "listen-port",
        String(config.listenPort),
      ],
      false,
    ],
  ];

  for (const peer of config.peers) {
    commands.push([
      "wg",
      [
        "set",
        interfaceName,
        "peer",
        peer.publicKey,
        "allowed-ips",
        deviceVpnHostCidr(peer.assignedAddress),
      ],
      false,
    ]);
    commands.push([
      "ip",
      [
        "route",
        "replace",
        deviceVpnHostCidr(peer.assignedAddress),
        "dev",
        interfaceName,
      ],
      false,
    ]);
  }

  commands.push([
    "ip",
    ["link", "set", "mtu", "1380", "up", "dev", interfaceName],
    false,
  ]);
  return commands;
}

export function deviceVpnFirewallRules(
  config: DeviceVpnRuntimeConfig,
  resolved: Map<string, string>,
  interfaceName = "wg0",
) {
  const forward: string[][] = [
    [
      "-A",
      DEVICE_VPN_FORWARD_CHAIN,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ],
  ];
  const dnat: string[][] = [];
  const snat: string[][] = [];

  for (const peer of config.peers) {
    const source = deviceVpnHostCidr(peer.assignedAddress);
    const allowedNetworks = new Set(peer.networkIds);
    for (const mapping of config.mappings) {
      if (!allowedNetworks.has(mapping.networkId)) continue;
      const target = resolved.get(mapping.attachmentAlias);
      if (!target) continue;
      dnat.push([
        "-A",
        DEVICE_VPN_DNAT_CHAIN,
        "-i",
        interfaceName,
        "-s",
        source,
        "-d",
        mapping.stableAddress,
        "-j",
        "DNAT",
        "--to-destination",
        target,
      ]);
      forward.push([
        "-A",
        DEVICE_VPN_FORWARD_CHAIN,
        "-i",
        interfaceName,
        "-s",
        source,
        "-d",
        target,
        "-j",
        "ACCEPT",
      ]);
      snat.push([
        "-A",
        DEVICE_VPN_SNAT_CHAIN,
        "-s",
        source,
        "-d",
        mapping.overlayCidr,
        "-j",
        "MASQUERADE",
      ]);
    }
  }

  forward.push([
    "-A",
    DEVICE_VPN_FORWARD_CHAIN,
    "-i",
    interfaceName,
    "-j",
    "REJECT",
  ]);
  forward.push([
    "-A",
    DEVICE_VPN_FORWARD_CHAIN,
    "-o",
    interfaceName,
    "-j",
    "REJECT",
  ]);

  return { forward, dnat, snat };
}
