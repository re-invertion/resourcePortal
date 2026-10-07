import { describe, expect, it } from "vitest";
import {
  DEVICE_VPN_DNAT_CHAIN,
  DEVICE_VPN_FORWARD_CHAIN,
  deviceVpnFirewallRules,
  deviceVpnWireGuardSetupCommands,
} from "./device-vpn-runtime.logic";
import type { DeviceVpnRuntimeConfig } from "./device-vpn-runtime.types";

const config: DeviceVpnRuntimeConfig = {
  gatewayId: "primary",
  listenPort: 51820,
  serverTunnelAddress: "100.64.0.1/11",
  privateKeyPath: "/run/secrets/device-vpn-private-key",
  runtimeTokenPath: "/run/secrets/device-vpn-runtime-token",
  heartbeatUrl: "https://rp.example/api/networking/device-vpn/runtime/heartbeat",
  peers: [
    {
      deviceId: "device-a",
      publicKey: "peer-a",
      assignedAddress: "100.64.0.2",
      networkIds: ["network-a"],
    },
    {
      deviceId: "device-b",
      publicKey: "peer-b",
      assignedAddress: "100.64.0.3",
      networkIds: ["network-b"],
    },
  ],
  mappings: [
    {
      networkId: "network-a",
      stableAddress: "10.240.10.10",
      overlayCidr: "10.200.10.0/24",
      attachmentAlias: "rp-att-a",
    },
    {
      networkId: "network-b",
      stableAddress: "10.240.20.10",
      overlayCidr: "10.200.20.0/24",
      attachmentAlias: "rp-att-b",
    },
  ],
};

describe("Device VPN runtime", () => {
  it("pins every WireGuard peer to its own /32 address", () => {
    const commands = deviceVpnWireGuardSetupCommands(config);
    expect(commands).toContainEqual([
      "wg",
      [
        "set",
        "wg0",
        "peer",
        "peer-a",
        "allowed-ips",
        "100.64.0.2/32",
      ],
      false,
    ]);
    expect(commands).toContainEqual([
      "wg",
      [
        "set",
        "wg0",
        "peer",
        "peer-b",
        "allowed-ips",
        "100.64.0.3/32",
      ],
      false,
    ]);
  });

  it("brings wg0 UP before adding any peer routes (real Swarm regression)", () => {
    const commands = deviceVpnWireGuardSetupCommands(config);
    const up = commands.findIndex(
      ([command, args]) =>
        command === "ip" && args[0] === "link" && args.includes("up"),
    );
    const routes = commands.flatMap(([command, args], index) =>
      command === "ip" && args[0] === "route" ? [index] : [],
    );
    expect(up).toBeGreaterThan(0);
    expect(routes).toHaveLength(config.peers.length);
    for (const routeIndex of routes) expect(routeIndex).toBeGreaterThan(up);
  });

  it("authorizes stable address mappings only for the peer's explicitly attached Networks", () => {
    const rules = deviceVpnFirewallRules(
      config,
      new Map([
        ["rp-att-a", "10.200.10.21"],
        ["rp-att-b", "10.200.20.31"],
      ]),
    );

    expect(rules.dnat).toContainEqual([
      "-A",
      DEVICE_VPN_DNAT_CHAIN,
      "-i",
      "wg0",
      "-s",
      "100.64.0.2/32",
      "-d",
      "10.240.10.10",
      "-j",
      "DNAT",
      "--to-destination",
      "10.200.10.21",
    ]);
    expect(
      rules.dnat.some(
        (rule) =>
          rule.includes("100.64.0.2/32") &&
          rule.includes("10.240.20.10"),
      ),
    ).toBe(false);
    expect(
      rules.forward.some(
        (rule) =>
          rule.includes("100.64.0.2/32") &&
          rule.includes("10.200.20.31"),
      ),
    ).toBe(false);
  });

  it("rejects all other forwarded traffic from or to the Device VPN interface", () => {
    const rules = deviceVpnFirewallRules(config, new Map());
    expect(rules.forward).toContainEqual([
      "-A",
      DEVICE_VPN_FORWARD_CHAIN,
      "-i",
      "wg0",
      "-j",
      "REJECT",
    ]);
    expect(rules.forward).toContainEqual([
      "-A",
      DEVICE_VPN_FORWARD_CHAIN,
      "-o",
      "wg0",
      "-j",
      "REJECT",
    ]);
  });
});
