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
    expect(script).toContain("Installing FRR for BGP route advertisement");
    expect(script).toContain("apt-get install -y frr");
    expect(script).toContain("systemctl enable --now resourceportal-gate.service");
    expect(script).toContain("/networking/gates/enroll");
    expect(script).toContain("/networking/gates/agent/heartbeat");
    expect(script).toContain("iptables-restore -w 5 --noflush");
    expect(script).toContain('LAN_SNAT_CHAIN="RP-GATE-LAN-SNAT"');
    expect(script).toContain("'-A %s -s %s -d %s -j MASQUERADE");
    expect(script).toContain('iptables -t nat -C POSTROUTING -j "$LAN_SNAT_CHAIN"');

    expect(script).toContain("'-A %s -o %s -j REJECT");
    expect(script).toContain("'-A %s -i %s -j REJECT");
    expect(script).not.toContain('iptables -F "$FIREWALL_CHAIN"');
    expect(script).toContain('HANDSHAKE_STALE_SECONDS="90"');
    expect(script).toContain(
      'wg show "$WG_INTERFACE" latest-handshakes',
    );
    expect(script).toContain(
      'WireGuard handshake stale for ${age}s; rebuilding tunnel',
    );
    expect(script.match(/AGENT_VERSION="gate-shell-v3"/g)).toHaveLength(2);
    expect(script).toContain('ALLOW_LAN_TO_RP=');
    expect(script).toContain('ALLOW_RP_TO_LAN=');
    expect(script).toContain('"$server_tunnel_source" "$lan"');
    expect(script).toContain("! BEGIN RESOURCEPORTAL-GATE");
    expect(script).toContain("ip prefix-list RP-GATE-EXPORT seq 65535 deny any");
    expect(script).toContain("ip prefix-list RP-GATE-IMPORT seq 5 deny any");
    expect(script).toContain("for daemon in zebra bgpd");
    expect(script).toContain("vtysh -b");
    expect(script).toContain("neighbor %s prefix-list RP-GATE-IMPORT in");
    expect(script).toContain("neighbor %s prefix-list RP-GATE-EXPORT out");
    expect(script).toContain("Refusing BGP reconcile because /etc/frr/frr.conf contains an unmanaged router bgp stanza");
    expect(script).not.toMatch(/redistribute\s+(connected|kernel|static|ospf)/);
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
