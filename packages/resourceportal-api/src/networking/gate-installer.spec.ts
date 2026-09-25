import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resourcePortalGateInstallerScript } from "./gate-installer";

describe("ResourcePortalGate installer", () => {
  it("emits valid bash with real shell parameter expansion", () => {
    const script = resourcePortalGateInstallerScript();
    expect(script).toContain('API_URL="${2:-}"');
    expect(script).toContain('ENROLLMENT_TOKEN="${2:-}"');
    expect(script).not.toContain('\\${2:-}');
    expect(script).toContain("wireguard-tools");
    expect(script).toContain("systemctl enable --now resourceportal-gate.service");
    expect(script).toContain("/networking/gates/enroll");
    expect(script).toContain("/networking/gates/agent/heartbeat");
    expect(script).toContain(
      'iptables -A "$FIREWALL_CHAIN" -o "$WG_INTERFACE" -j REJECT',
    );
    expect(script).toContain(
      'iptables -A "$FIREWALL_CHAIN" -i "$WG_INTERFACE" -j REJECT',
    );
    expect(script).toContain('HANDSHAKE_STALE_SECONDS="90"');
    expect(script).toContain(
      'wg show "$WG_INTERFACE" latest-handshakes',
    );
    expect(script).toContain(
      'WireGuard handshake stale for ${age}s; rebuilding tunnel',
    );
    expect(script).not.toContain("__RP_SHELL_EXPAND__");

    const syntax = spawnSync("bash", ["-n"], {
      input: script,
      encoding: "utf8",
    });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe("");
  });

  it("keeps v1 IP-routing only without private DNS setup", () => {
    const script = resourcePortalGateInstallerScript();
    expect(script).not.toMatch(/resolvconf|systemd-resolved|dnsmasq|nameserver/i);
    expect(script).toContain("AllowedIPs");
    expect(script).toContain("ip -o -4 route show scope link");
    expect(script).toContain("add static routes on your LAN router");
  });
});
