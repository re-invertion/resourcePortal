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
    expect(script).toContain("systemctl enable resourceportal-gate.service");
    expect(script).toContain("systemctl restart resourceportal-gate.service");
    expect(script).not.toContain("systemctl enable --now resourceportal-gate.service");
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

describe("ResourcePortalGate LAN discovery (issue #279)", () => {
  const script = resourcePortalGateInstallerScript();
  const functionPairs = [...script.matchAll(
    /discover_lan_addresses\(\) \{[\s\S]*?\n\}\n\ndiscover_lan_cidrs\(\) \{[\s\S]*?\n\}/g,
  )].map((match) => match[0]);

  function runDiscovery(functions: string, tunnelUp: boolean, physicalOverlap = false, onlyTunnel = false) {
    const addresses = [
      ...(onlyTunnel ? [] : [
        "2: eth0    inet 192.168.50.2/24 brd 192.168.50.255 scope global eth0",
        "3: wlan0   inet 192.168.60.2/24 brd 192.168.60.255 scope global wlan0",
      ]),
      ...(tunnelUp ? ["4: rp-gate inet 100.96.0.2/30 scope global rp-gate"] : []),
    ];
    const routes = [
      ...(onlyTunnel ? [] : [
        "192.168.50.0/24 dev eth0 proto kernel scope link src 192.168.50.2",
        "192.168.60.0/24 dev wlan0 proto kernel scope link src 192.168.60.2",
      ]),
      ...(tunnelUp ? [
        "100.96.0.0/30 dev rp-gate proto kernel scope link src 100.96.0.2",
        "10.240.10.0/24 dev rp-gate scope link",
        "10.240.20.0/24 dev rp-gate scope link",
      ] : []),
      ...(physicalOverlap ? ["10.240.10.0/24 dev eth0 scope link"] : []),
    ];
    const mock = [
      "set -euo pipefail",
      'WG_INTERFACE="rp-gate"',
      "ip() {",
      '  if [ "$*" = "-o -4 addr show scope global" ]; then',
      "    cat <<'MOCK_ADDRESSES'",
      ...addresses,
      "MOCK_ADDRESSES",
      '  elif [ "$*" = "-o -4 route show scope link" ]; then',
      "    cat <<'MOCK_ROUTES'",
      ...routes,
      "MOCK_ROUTES",
      "  else return 2; fi",
      "}",
      functions,
      "discover_lan_addresses | jq -c .",
      "discover_lan_cidrs | jq -c .",
    ].join("\n");
    const result = spawnSync("bash", ["-c", mock], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const [lanAddresses, lanCidrs] = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line) as string[]);
    return { lanAddresses, lanCidrs };
  }

  it("emits syntactically valid Bash for the installed agent, not only the wrapper", () => {
    const generated = script.match(/<<\x27RP_GATE_AGENT\x27\n([\s\S]*?)\nRP_GATE_AGENT/);
    expect(generated).not.toBeNull();
    const syntax = spawnSync("bash", ["-n"], { input: generated?.[1] ?? "", encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("includes the discovery helpers in both fresh installer and installed agent", () => {
    expect(functionPairs).toHaveLength(2);
  });

  it.each([{ path: "enrollment", index: 0 }, { path: "heartbeat", index: 1 }])("keeps physical LAN only before tunnel startup ($path)", ({ index }) => {
    expect(runDiscovery(functionPairs[index], false)).toEqual({
      lanAddresses: ["192.168.50.2", "192.168.60.2"],
      lanCidrs: ["192.168.50.0/24", "192.168.60.0/24"],
    });
  });

  it.each([{ path: "enrollment", index: 0 }, { path: "heartbeat", index: 1 }])("excludes rp-gate on startup, restart and re-enrollment ($path)", ({ index }) => {
    const once = runDiscovery(functionPairs[index], true);
    expect(once).toEqual({
      lanAddresses: ["192.168.50.2", "192.168.60.2"],
      lanCidrs: ["192.168.50.0/24", "192.168.60.0/24"],
    });
    expect(runDiscovery(functionPairs[index], true)).toEqual(once);
  });

  it.each([{ path: "enrollment", index: 0 }, { path: "heartbeat", index: 1 }])("handles tunnel-only network discovery under pipefail ($path)", ({ index }) => {
    expect(runDiscovery(functionPairs[index], true, false, true)).toEqual({
      lanAddresses: [],
      lanCidrs: [],
    });
  });

  it.each([{ path: "enrollment", index: 0 }, { path: "heartbeat", index: 1 }])("does not conceal overlapping routes on physical LAN ($path)", ({ index }) => {
    const result = runDiscovery(functionPairs[index], true, true);
    expect(result.lanCidrs).toContain("10.240.10.0/24");
    expect(result.lanCidrs).not.toContain("10.240.20.0/24");
  });
});
