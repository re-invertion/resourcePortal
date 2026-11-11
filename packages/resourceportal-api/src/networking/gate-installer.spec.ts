import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { resourcePortalGateInstallerScript } from "./gate-installer";
import {plainToInstance} from "class-transformer";
import {validateSync} from "class-validator";
import {createHash} from "node:crypto";
import {managedBridgeName} from "./remote-lan-managed-uplink";
import {GateHeartbeatDto} from "./dto/gate-heartbeat.dto";


describe("RP Gate LAN Attachments-only installer", () => {
  const script = resourcePortalGateInstallerScript();
  const agent = script.match(/<<'RP_GATE_AGENT'\n([\s\S]*?)\nRP_GATE_AGENT/)?.[1] ?? "";
  const python = script.match(/<<'RP_GATE_LAN_PYTHON'\n([\s\S]*?)\nRP_GATE_LAN_PYTHON/)?.[1] ?? "";
  it("bundles the fail-closed Netplan NetworkManager bridge with independent rollback", () => {
    const uplink=script.match(/<<'RP_GATE_UPLINK_PYTHON'\n([\s\S]*?)\nRP_GATE_UPLINK_PYTHON/)?.[1]??"";
    expect(script).toContain("python3-yaml");
    expect(uplink).toContain("def preflight_networkmanager(");
    expect(uplink).toContain("def rollback_networkmanager(");
    expect(uplink).toContain("OnUnitActiveSec=60s");
    expect(uplink).toContain("netplan_override(plan)");
    expect(uplink).toContain('call("netplan", "apply")');
  });
  it("configures a single physical Ethernet uplink during one-command enrollment", () => {
    expect(script).toContain('mapfile -t CANDIDATES');
    expect(script).toContain('--uplink-device');
    expect(script).toContain('--skip-managed-uplink');
    expect(script).toContain('read -r UPLINK_DEVICE < /dev/tty');
    expect(script).toContain('preflight --device');
    expect(script).toContain('apply --device');
    expect(script).toContain('resourceportal-gate-uplink');
    expect(script).toContain('Verified shared LAN uplink already exists');
    expect(script).toContain('auto-confirm and rollback armed');
    expect(script).not.toContain('systemctl stop NetworkManager');
    expect(script).not.toContain('nmcli radio wifi off');
  });

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
    expect(script.match(/AGENT_VERSION="gate-l2-v4"/g)).toHaveLength(1);
  });
  it("enforces on-device monotonic deadline, reboot, replay and revision safety in the real Python helper",()=>{
    const source = resolve(__dirname,"../../../../test/test_gate_authorization_lease.py");
    const outcome = spawnSync("python3",[source],{encoding:"utf8",
      timeout:12000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
    expect(outcome.status,outcome.stderr||outcome.error?.message).toBe(0);
  });
  it("serializes a successful authenticated heartbeat and authoritative revoke with the watchdog lock",()=>{
    expect(agent).toContain('LEASE_LOCK_FILE="$LEASE_RUNTIME_DIR/authorization.lock"');
    expect(agent).toContain('flock -x -w 45 "$LEASE_LOCK_FD"');
    expect(script).toContain('for tool in curl jq wg wg-quick python3 nft ip flock systemctl');
    const success = agent.indexOf('if [ "$HTTP_CODE" = "200" ]; then');
    const acquire = agent.indexOf('lock_authorization || die',success);
    const transition = agent.indexOf('--transition --nonce "$CHALLENGE"',success);
    const apply = agent.indexOf('elif ! apply_config "$RESPONSE"',success);
    const renew = agent.indexOf('--renew --nonce "$CHALLENGE"',success);
    const release = agent.indexOf('unlock_authorization',renew);
    expect(success).toBeGreaterThan(0);
    expect(acquire).toBeGreaterThan(success);
    expect(acquire).toBeLessThan(transition);
    expect(transition).toBeLessThan(apply);
    expect(apply).toBeLessThan(renew);
    expect(renew).toBeLessThan(release);
    const denied = agent.indexOf('elif [[ "$HTTP_CODE" =~ ^(400',release);
    expect(denied).toBeGreaterThan(release);
    expect(agent.indexOf('lock_authorization',denied)).toBeGreaterThan(denied);
    expect(agent.indexOf('unlock_authorization',denied)).toBeGreaterThan(denied);
  });
  it("parses the real curl response suffix without misclassifying HTTP 200 as an outage",()=>{
    const parser=agent.split("\n").find(line =>
      line.includes("HTTP_CODE=") && line.includes("RAW_RESPONSE##"));
    expect(parser).toBeDefined();
    for(const status of ["200","401","404","502"]) {
      const bash = "RAW_RESPONSE=$(printf '%s\\n"+status+"' 'response-body')\n" +
        parser + "\nprintf '%s' \"$HTTP_CODE\"";
      const result = spawnSync("bash",["-c",bash],{encoding:"utf8",timeout:5000});
      expect(result.status,result.stderr).toBe(0);
      expect(result.stdout).toBe(status);
    }
  });
  it("shortens only live-only heartbeat scheduling even for an old 60/120s agent interval",()=>{
    const line=agent.split("\n").find(s=>
      s.includes('if [ "$LIVE_ONLY" -eq 1 ] && [ "$DELAY" -gt 10 ]'));
    expect(line).toBeDefined();
    for(const interval of [5,30,60,120]) {
      for(const live of [0,1]) {
        const bash = 'INTERVAL='+interval+'; LIVE_ONLY='+live+
          '; DELAY="$INTERVAL"; '+line+'; printf "%s" "$DELAY"';
        const result=spawnSync("bash",["-c",bash],{encoding:"utf8",timeout:5000});
        expect(result.status,result.stderr).toBe(0);
        expect(result.stdout).toBe(String(live===1 ? Math.min(interval,10) : interval));
      }
    }
    expect(agent).toContain("LIVE_ONLY=0");
    expect(agent).toContain("LIVE_ONLY=1");
    expect(agent).toContain('RENEW_STATUS" -eq 2');
    expect(agent).toContain('python3 "$LEASE_AGENT" --valid');
  });
  it("packages every Python helper required by the production Gate installer",()=>{
    const dockerfile = readFileSync(resolve(__dirname,"../../../../Dockerfile"),"utf8");
    for(const asset of [
      "gate-lan-agent.py","gate-managed-uplink.py","gate-authorization-lease.py",
    ]) {
      expect(dockerfile).toContain(
        "COPY packages/resourceportal-api/src/networking/"+asset+
        " ./dist/src/networking/"+asset);
    }
  });
  it("accepts real Gate v2 subnet/mask/capabilities without whitelisting arbitrary properties",()=>{
    const gateId="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
    const networkCidr="192.168.100.0/24";
    const physicalInterface="eth0";
    const observation={
      protocol:1,gateId,
      segmentId:createHash("sha256").update(gateId+":eth0:"+networkCidr)
        .digest("hex").slice(0,24),
      physicalInterface,bridge:managedBridgeName(gateId,physicalInterface),
      networkCidr,prefix:24,netmask:"255.255.255.0",gateway:"192.168.100.1",
      discoveryMethod:"host-verified",observedAt:new Date().toISOString(),
      agentVersion:"gate-l2-v2",capabilities:["ManagedSharedUplink","LANDiscoveryV1"],
      state:"Ready"
    };
    const options={whitelist:true,forbidNonWhitelisted:true};
    const decode=(raw:unknown)=>validateSync(plainToInstance(GateHeartbeatDto,raw),options);
    expect(decode({agentVersion:"gate-l2-v2",lanObservation:observation})).toEqual([]);
    expect(decode({agentVersion:"gate-l2-v1"})).toEqual([]);
    expect(decode({agentVersion:"gate-l2-v2",lanObservation:{...observation,
      untrusted:"payload"}})).not.toEqual([]);
    expect(decode({agentVersion:"gate-l2-v2",lanObservation:{...observation,
      gateway:"999.999.999.999"}})).not.toEqual([]);
  });
  it("sends only machine-bound enrollment and heartbeat credentials", () => {
    expect(script).toContain('agentVersion:"gate-l2-v4"');
    expect(agent).toContain('authorization: Bearer $AGENT_TOKEN');
    expect(agent).toContain('agentVersion:"gate-l2-v4",leaseNonce:$nonce,lanObservation:$observation');
    expect(agent).toContain('(.lanAttachments|length)<=64');
    expect(agent).toContain('.gateId==$gate');
    expect(script).not.toContain("lanCidrs:$lanCidrs");
    expect(script).not.toContain("lanAddresses:$lanAddresses");
  });
  it("reports Gate proof collector failures without leaking stderr or fabricating Active",()=>{
    expect(agent).toContain('LAN proof collection failed (gate observation unavailable)');
    expect(agent).toContain("collector_execution_failed");
    expect(agent).toContain("lanProofDiagnostic:$diag");
    expect(agent).not.toContain('--observed-attachments 2>/dev/null || printf');
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
    expect(agent).toContain("Control plane Degraded; continuing only existing leased forwarding");
    expect(agent).toContain("Heartbeat failed without valid authorization; forwarding revoked");
    expect(agent).toContain("^(400|401|403|405|409|410|412|422)$");
    expect(agent).toContain("Gate authorization rejected by API; forwarding revoked immediately");
    expect(agent).toContain("Control plane Degraded; continuing only existing leased forwarding");
    expect(agent).toContain('RENEW_STATUS=0');
    expect(agent).toContain('--transition --nonce "$CHALLENGE"');
    expect(agent.indexOf('--transition --nonce "$CHALLENGE"'))
      .toBeLessThan(agent.indexOf('elif ! apply_config "$RESPONSE"'));
    expect(agent).toContain('Invalid authenticated LAN topology transition; forwarding revoked');
    expect(agent).toContain('RENEW_STATUS" -eq 2');
    expect(agent).toContain('Untrusted lease response; forwarding revoked');
    expect(agent).toContain("authorizationLease.nonce==$nonce");
    expect(script).toContain("--update");
    expect(script).toContain("Existing Gate bearer not accepted by RP; update refused");
    expect(script).toContain("supportedAgentVersions");
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
