import { describe, expect, it } from "vitest";
import {
  firewallRules,
  hostAddressCidr,
  wireGuardSetupCommands,
} from "./gate-runtime.logic";
import type { GateRuntimeConfig } from "./gate-runtime.types";

const config: GateRuntimeConfig = {
  gateId: "gate-1",
  listenPort: 51820,
  serverTunnelAddress: "10.253.0.1/30",
  clientTunnelAddress: "10.253.0.2/30",
  peerPublicKey: "peer-public-key",
  peerLanCidrs: ["192.168.50.0/24"],
  privateKeyPath: "/run/secrets/gate-private-key",
  mappings: [
    {
      stableAddress: "10.240.12.10",
      overlayCidr: "10.200.12.0/24",
      attachmentAlias: "rp-att-attachment-1",
    },
  ],
};

describe("ResourcePortalGate runtime", () => {
  it("configures WireGuard with only the Gate peer source address", () => {
    expect(hostAddressCidr(config.clientTunnelAddress)).toBe("10.253.0.2/32");
    expect(wireGuardSetupCommands(config)).toContainEqual([
      "wg",
      [
        "set",
        "wg0",
        "private-key",
        "/run/secrets/gate-private-key",
        "listen-port",
        "51820",
        "peer",
        "peer-public-key",
        "allowed-ips",
        "10.253.0.2/32,192.168.50.0/24",
      ],
      false,
    ]);
  });

  it("installs LAN return-path routes but rejects unsolicited overlay-to-LAN forwarding", () => {
    const commands = wireGuardSetupCommands(config);
    expect(commands).toContainEqual([
      "ip",
      ["route", "replace", "192.168.50.0/24", "dev", "wg0"],
      false,
    ]);

    const rules = firewallRules(
      config,
      new Map([["rp-att-attachment-1", "10.200.12.21"]]),
    );
    expect(
      rules.forward.some(
        (rule) =>
          rule.includes("-o") &&
          rule.includes("wg0") &&
          rule.includes("192.168.50.0/24"),
      ),
    ).toBe(false);
  });

  it("DNATs only configured stable addresses and rejects other forwarded tunnel traffic", () => {
    const rules = firewallRules(
      config,
      new Map([["rp-att-attachment-1", "10.200.12.21"]]),
    );
    expect(rules.dnat).toContainEqual([
      "-A",
      "RP-GATE-DNAT",
      "-i",
      "wg0",
      "-d",
      "10.240.12.10",
      "-j",
      "DNAT",
      "--to-destination",
      "10.200.12.21",
    ]);
    expect(rules.snat).toContainEqual([
      "-A",
      "RP-GATE-SNAT",
      "-s",
      "10.253.0.2/32",
      "-d",
      "10.200.12.0/24",
      "-j",
      "MASQUERADE",
    ]);
    expect(rules.snat).toContainEqual([
      "-A",
      "RP-GATE-SNAT",
      "-s",
      "192.168.50.0/24",
      "-d",
      "10.200.12.0/24",
      "-j",
      "MASQUERADE",
    ]);
    expect(rules.forward).toContainEqual([
      "-A",
      "RP-GATE-FWD",
      "-i",
      "wg0",
      "-j",
      "REJECT",
    ]);
    expect(rules.forward).toContainEqual([
      "-A",
      "RP-GATE-FWD",
      "-o",
      "wg0",
      "-j",
      "REJECT",
    ]);
  });
});

describe("Site VPN directional firewall", () => {
  const resolved = new Map([["rp-att-attachment-1", "10.200.12.21"]]);

  it("preserves LAN→RP by default while blocking RP→LAN initiation", () => {
    const rules = firewallRules(config, resolved);
    expect(rules.dnat).toHaveLength(1);
    expect(rules.forward.some((r) => r.includes("NEW") && r.includes("-i") && r.includes("wg0"))).toBe(true);
    expect(rules.forward.some((r) => r.includes("NEW") && r.includes("-o") && r.includes("wg0"))).toBe(false);
  });

  it("blocks LAN→RP when disabled, while preserving established reply traffic", () => {
    const rules = firewallRules({ ...config, allowLanToRp: false }, resolved);
    expect(rules.dnat).toHaveLength(0);
    expect(rules.forward.filter((r) => r.includes("NEW"))).toHaveLength(0);
    expect(rules.forward.some((r) => r.includes("ESTABLISHED,RELATED"))).toBe(true);
  });

  it("permits RP→LAN only for attached overlays and reported LAN CIDRs using tunnel SNAT", () => {
    const rules = firewallRules({
      ...config,
      allowLanToRp: false,
      allowRpToLan: true,
      rpOverlayCidrs: ["10.200.12.0/24"],
    }, resolved);
    expect(rules.dnat).toHaveLength(0);
    expect(rules.forward).toContainEqual([
      "-A", "RP-GATE-FWD", "-o", "wg0", "-s", "10.200.12.0/24",
      "-d", "192.168.50.0/24", "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT",
    ]);
    expect(rules.snat).toContainEqual([
      "-A", "RP-GATE-SNAT", "-o", "wg0", "-s", "10.200.12.0/24",
      "-d", "192.168.50.0/24", "-j", "SNAT", "--to-source", "10.253.0.1",
    ]);
    expect(rules.forward.some((r) => r.includes("0.0.0.0/0"))).toBe(false);
  });
});
