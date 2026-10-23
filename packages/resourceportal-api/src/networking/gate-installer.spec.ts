import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resourcePortalGateInstallerScript } from "./gate-installer";

describe("RP Gate LAN Attachments-only installer", () => {
  const script = resourcePortalGateInstallerScript();
  const agent = script.match(/<<'RP_GATE_AGENT'\n([\s\S]*?)\nRP_GATE_AGENT/)?.[1] ?? "";
  const python = script.match(/<<'RP_GATE_LAN_PYTHON'\n([\s\S]*?)\nRP_GATE_LAN_PYTHON/)?.[1] ?? "";
  it("generates valid fresh-install and installed-agent Bash", () => {
    for (const source of [script, agent]) {
      const result = spawnSync("bash", ["-n"], { input:source, encoding:"utf8" });
      expect(result.status,result.stderr).toBe(0);
    }
    expect(script).toContain("/networking/gates/enroll");
    expect(agent).toContain("/networking/gates/agent/heartbeat");
    expect(script).not.toContain("__RP_SHELL_EXPAND__");
    expect(script).not.toContain("__RP_GATE_LAN_PYTHON__");
    expect(script).toContain("systemctl restart resourceportal-gate.service");
    expect(script.match(/AGENT_VERSION="gate-l2-v1"/g)).toHaveLength(1);
  });
  it("sends only machine-bound enrollment and heartbeat credentials", () => {
    expect(script).toContain('agentVersion:"gate-l2-v1"');
    expect(agent).toContain('authorization: Bearer $AGENT_TOKEN');
    expect(agent).toContain('{"agentVersion":"gate-l2-v1"}');
    expect(agent).toContain('(.lanAttachments|length)<=64');
    expect(agent).toContain('.gateId==$gate');
    expect(script).not.toContain("lanCidrs:$lanCidrs");
    expect(script).not.toContain("lanAddresses:$lanAddresses");
  });
  it("never enables routed site access, forwarding or BGP", () => {
    expect(script).not.toMatch(/apt-get install -y frr|sync_bgp|router bgp/i);
    expect(script).not.toContain("sysctl --system");
    expect(agent).not.toContain("iptables-restore");
    expect(agent).not.toContain("MASQUERADE");
    expect(agent).toContain('AllowedIPs = $allowed');
    expect(agent).toContain('server%/*');
  });
  it("revokes LAN bridges on downtime, invalid policy, restart and signals", () => {
    expect(agent).toContain("trap shutdown EXIT");
    expect(agent).toContain("trap 'exit 0' SIGTERM SIGINT");
    expect(agent).toContain('python3 "$LAN_AGENT" --revoke-all');
    expect(agent).toContain("Heartbeat failure; bridge revoked");
    expect(agent).toContain('if [ "$count" -eq 0 ]; then revoke_lan; down_tunnel; return; fi');
    expect(python).toContain("Missing fresh authenticated WireGuard peer handshake");
    expect(python).toContain("LAN attachment requires a live dedicated Ethernet/VLAN interface");
    expect(python).toContain("Untrusted application MAC");
    expect(python).toContain("Unsafe partial LAN reconciliation; cleanup required");
  });
  it("removes only RP-owned legacy routing and discovery resources", () => {
    expect(agent).toContain("iptables -D FORWARD -j RP-GATE-LAN");
    expect(agent).toContain("iptables -t nat -D POSTROUTING -j RP-GATE-LAN-SNAT");
    expect(agent).toContain("systemctl disable --now resourceportal-gate-discovery.service");
    expect(agent).toContain("rm -f /etc/systemd/system/resourceportal-gate-discovery.service");
    expect(agent).not.toContain("systemctl disable --now frr");
    expect(agent).not.toContain("sysctl -w net.ipv4.ip_forward");
    expect(script).toContain("nftables");
  });
});
