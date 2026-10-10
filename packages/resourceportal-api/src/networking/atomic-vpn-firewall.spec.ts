import { describe, expect, it } from "vitest";
import { atomicVpnFirewallRestore } from "./atomic-vpn-firewall";

describe("atomic VPN firewall replacement", () => {
  const input = {
    forwardChain: "RP-GATE-FORWARD",
    dnatChain: "RP-GATE-DNAT",
    snatChain: "RP-GATE-SNAT",
    forward: [
      ["-A", "RP-GATE-FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
      ["-A", "RP-GATE-FORWARD", "-i", "wg0", "-j", "REJECT"],
    ],
    dnat: [["-A", "RP-GATE-DNAT", "-i", "wg0", "-d", "10.0.0.3", "-j", "DNAT", "--to-destination", "172.19.0.5"]],
    snat: [["-A", "RP-GATE-SNAT", "-s", "10.0.0.0/24", "-j", "MASQUERADE"]],
  };
  it("updates filter and nat at their commit boundaries", () => {
    const script = atomicVpnFirewallRestore(input);
    expect(script).toContain("*filter\n-F RP-GATE-FORWARD\n-A RP-GATE-FORWARD");
    expect(script).toContain("COMMIT\n*nat\n-F RP-GATE-DNAT\n-F RP-GATE-SNAT");
    expect(script).toMatch(/-A RP-GATE-FORWARD -i wg0 -j REJECT\nCOMMIT/);
    expect(script.match(/COMMIT/g)).toHaveLength(2);
  });
  it("rejects unsafe operator/newline injection", () => {
    expect(() => atomicVpnFirewallRestore({ ...input, forward: [["-A", "RP-GATE-FORWARD", "-d", "0.0.0.0/0\n-F INPUT"]] })).toThrow();
    expect(() => atomicVpnFirewallRestore({ ...input, dnat: [["-A", "OTHER-CHAIN", "-j", "ACCEPT"]] })).toThrow();
  });
});
