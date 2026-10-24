#!/usr/bin/env python3
"""ResourcePortal Gate managed shared Ethernet uplink.

Certified scope: wired Debian/systemd-networkd, one DHCPv4 management NIC,
one default route, a single /16..30 LAN. No Wi-Fi, global IPv6, VLAN trunk,
NetworkManager, dhcpcd, multiple DHCP servers, or foreign bridge ownership.

The persistent watchdog is installed and enabled BEFORE networkd is changed.
Only a local --confirm after observed bridge state and control-plane handshake
cancels rollback. Crash/reboot/nonconfirmation restores the exact old .network
file. No LAN attachment may create or delete this host-owned bridge.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

STATE = Path("/etc/resourceportal-gate")
NETWORKD = Path("/etc/systemd/network")
SYSTEMD = Path("/etc/systemd/system")
TOOL = Path("/usr/local/sbin/resourceportal-gate-uplink")
WATCH = "resourceportal-gate-uplink-rollback"
DEVICE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$")
NETWORK_FILE = re.compile(r"^[A-Za-z0-9_.-]+\.network$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def call(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)
    if result.returncode:
        raise RuntimeError("%s: %s" % (args[0], result.stderr.strip()[:300]))
    return result.stdout.strip()


def write(path: Path, content: str, mode: int = 0o600):
    # Only fixed paths from a root-owned directory; no attacker-selected filenames.
    tmp = path.with_name(path.name + ".rp-stage")
    if tmp.is_symlink():
        raise ValueError("Refusing symlinked temporary network configuration")
    if tmp.exists():
        if tmp.stat().st_uid != 0 or tmp.stat().st_mode & 0o077:
            raise ValueError("Refusing unsafe staging file")
        tmp.unlink()
    with open(tmp, "x", encoding="utf-8") as file:
        os.fchmod(file.fileno(), mode)
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def bridge_name(gate: str, device: str) -> str:
    if not UUID.fullmatch(gate) or not DEVICE.fullmatch(device):
        raise ValueError("Invalid Gate and Ethernet interface identity")
    return "rp-gb-" + hashlib.sha256((gate + ":" + device).encode()).hexdigest()[:8]


def snapshot():
    return (json.loads(call("ip", "-j", "-d", "link", "show")),
            json.loads(call("ip", "-j", "addr", "show")),
            json.loads(call("ip", "-j", "-4", "route", "show", "table", "main")))


def read_control_config():
    path = STATE / "state.json"
    data = json.loads(path.read_text())
    if not UUID.fullmatch(data.get("gateId", "")) or not data.get("apiUrl") or not data.get("agentToken"):
        raise ValueError("Gate must be enrolled before uplink migration")
    if not str(data["apiUrl"]).startswith("https://"):
        raise ValueError("Gate control plane must use HTTPS")
    return data


def preflight(device: str) -> dict:
    if not DEVICE.fullmatch(device) or device in ("lo", "rp-gate", "docker0"):
        raise ValueError("Unsafe management Ethernet identity")
    config = read_control_config()
    gate = config["gateId"]
    br = bridge_name(gate, device)
    for manager in ("NetworkManager", "dhcpcd"):
        if subprocess.run(("systemctl", "is-active", "--quiet", manager), check=False).returncode == 0:
            raise ValueError("A competing host network manager is active")
    if call("systemctl", "is-active", "systemd-networkd") != "active":
        raise ValueError("Only systemd-networkd-managed Ethernet is supported")
    links, addresses, routes = snapshot()
    link = next((x for x in links if x.get("ifname") == device), None)
    if not link or link.get("link_type") != "ether" or link.get("linkinfo", {}).get("info_kind") or link.get("master"):
        raise ValueError("Only an unmanaged-by-bridge physical Ethernet uplink is eligible")
    if link.get("operstate") != "UP" or any(x.get("ifname") == br for x in links):
        raise ValueError("Physical link is down or bridge name is already in use")
    ipv4 = [a for item in addresses if item.get("ifname") == device
            for a in item.get("addr_info", []) if a.get("family") == "inet" and a.get("scope") != "host"]
    ipv6 = [a for item in addresses if item.get("ifname") == device
            for a in item.get("addr_info", []) if a.get("family") == "inet6" and a.get("scope") != "link"]
    if len(ipv4) != 1 or ipv6:
        raise ValueError("Expected exactly one DHCPv4 host address without global IPv6")
    local = ipaddress.ip_interface(ipv4[0]["local"] + "/" + str(ipv4[0]["prefixlen"]))
    if local.version != 4 or not 16 <= local.network.prefixlen <= 30:
        raise ValueError("Unsupported management CIDR")
    defaults = [r for r in routes if r.get("dst") in ("default", "0.0.0.0/0")]
    if len(defaults) != 1 or defaults[0].get("dev") != device or not defaults[0].get("gateway"):
        raise ValueError("Host management default route is ambiguous")
    gateway = ipaddress.ip_address(defaults[0]["gateway"])
    if gateway not in local.network or gateway in (local.network.network_address, local.network.broadcast_address):
        raise ValueError("Management gateway is not a usable on-link IPv4 address")
    # networkctl's Network File field identifies the effective owning configuration.
    report = call("networkctl", "status", device, "--no-pager", "--no-legend")
    marker = re.search(r"Network File:\s+(\/etc\/systemd\/network\/[A-Za-z0-9_.-]+\.network)\s*(?:\n|$)", report)
    if not marker:
        raise ValueError("Management NIC has no uniquely owned /etc/systemd/network configuration")
    original = Path(marker.group(1))
    if not NETWORK_FILE.fullmatch(original.name) or original.is_symlink():
        raise ValueError("Refusing symlinked or foreign networkd configuration")
    text = original.read_text()
    if not re.search(r"(?m)^\s*DHCP\s*=\s*(?:yes|ipv4)\s*$", text) or "[Bridge]" in text or "Bridge=" in text:
        raise ValueError("Only simple networkd DHCPv4 configurations may be migrated")
    # Do not change a shared wildcard .network definition.
    if not re.search(r"(?m)^\s*Name\s*=\s*" + re.escape(device) + r"\s*$", text):
        raise ValueError("Network file must match only the selected device")
    new_names = [NETWORKD / ("09-" + br + ".netdev"), NETWORKD / ("09-" + br + ".network")]
    if any(x.exists() or x.is_symlink() for x in new_names):
        raise ValueError("Managed uplink config already exists")
    return {"protocol": 1, "gateId": gate, "device": device, "bridge": br,
            "networkCidr": str(local.network), "gateway": str(gateway),
            "originalPath": str(original), "originalText": text,
            "originalMode": stat.S_IMODE(original.stat().st_mode),
            "state": "Preflight", "checkedAt": time.time()}


def config_files(plan: dict) -> dict[str, str]:
    br, dev = plan["bridge"], plan["device"]
    # A separate .netdev contains the bridge; networkd must move DHCP from
    # the physical link to it (rather than host 'ip addr' commands).
    return {
        "original": "[Match]\nName=" + dev + "\n\n[Network]\nBridge=" + br + "\n",
        "netdev": "[NetDev]\nName=" + br + "\nKind=bridge\n\n[Bridge]\nSTP=yes\nVLANFiltering=yes\nMulticastSnooping=no\n",
        "bridge": "[Match]\nName=" + br + "\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\nLinkLocalAddressing=no\n\n[DHCPv4]\nUseRoutes=yes\nUseDNS=yes\n",
    }


def watchdog_files() -> tuple[str, str]:
    service = ("[Unit]\nDescription=ResourcePortal Gate uplink automatic rollback\n"
               "ConditionPathExists=/etc/resourceportal-gate/uplink-checkpoint.json\n"
               "[Service]\nType=oneshot\nExecStart=" + str(TOOL) + " rollback\n")
    timer = ("[Unit]\nDescription=Rollback unconfirmed RP Gate networkd migration\n"
             "[Timer]\nOnActiveSec=120s\nOnBootSec=120s\nAccuracySec=1s\n"
             "Unit=" + WATCH + ".service\n"
             "[Install]\nWantedBy=timers.target\n")
    return service, timer


def checkpoint_file() -> Path:
    return STATE / "uplink-checkpoint.json"


def load_checkpoint():
    path = checkpoint_file()
    if path.is_symlink():
        raise ValueError("Unsafe checkpoint symlink")
    return json.loads(path.read_text())


def arm(plan: dict):
    if checkpoint_file().exists():
        raise ValueError("An earlier migration must be confirmed or rolled back first")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    network = config_files(plan)
    service, timer = watchdog_files()
    write(SYSTEMD / (WATCH + ".service"), service)
    write(SYSTEMD / (WATCH + ".timer"), timer)
    write(checkpoint_file(), json.dumps(plan, sort_keys=True))
    try:
        call("systemctl", "daemon-reload")
        call("systemctl", "enable", "--now", WATCH + ".timer")
        if call("systemctl", "is-active", WATCH + ".timer") != "active":
            raise RuntimeError("Rollback watchdog is not armed")
        paths = (Path(plan["originalPath"]),
                 NETWORKD / ("09-" + plan["bridge"] + ".netdev"),
                 NETWORKD / ("09-" + plan["bridge"] + ".network"))
        for file, contents, mode in zip(paths, (network["original"], network["netdev"], network["bridge"]),
                                        (plan["originalMode"], 0o644, 0o644)):
            write(file, contents, mode=mode)
        call("networkctl", "reload")
        call("networkctl", "reconfigure", plan["device"])
        # Control can disappear here. The watchdog rolls back independently.
    except Exception:
        # No controller heartbeat is needed for an immediate local rollback.
        rollback()
        raise


def verify(plan: dict):
    # managed-uplink.json is not issued until verification has completed;
    # this uses the same raw netlink contract as the Gate Agent.
    links, addresses, routes = snapshot()
    br = plan["bridge"]
    parent = next((x for x in links if x.get("ifname") == plan["device"]), None)
    bridge = next((x for x in links if x.get("ifname") == br), None)
    if not parent or parent.get("master") != br or not bridge or bridge.get("linkinfo", {}).get("info_kind") != "bridge":
        raise RuntimeError("Managed bridge has not acquired physical Ethernet")
    ownership = "rp-lan:" + plan["gateId"] + ":" + plan["device"]
    # On cold boot a Linux ifalias may be absent; an unrelated alias is not
    # evidence of RP ownership and must never be overwritten.
    if bridge.get("ifalias") not in (None, "", ownership):
        raise RuntimeError("Foreign managed bridge alias detected")
    if plan["bridge"] != bridge_name(plan["gateId"], plan["device"]):
        raise RuntimeError("Unexpected managed bridge identity")
    conf = NETWORKD / ("09-" + br + ".netdev")
    if not conf.is_file() or conf.is_symlink() or "Name=" + br not in conf.read_text():
        raise RuntimeError("RP-owned persistent networkd bridge config not found")
    if any(item.get("ifname") == plan["device"] and any(a.get("family") in ("inet", "inet6")
           for a in item.get("addr_info", [])) for item in addresses):
        raise RuntimeError("Physical interface retains a host address")
    present = [a for item in addresses if item.get("ifname") == br for a in item.get("addr_info", [])
               if a.get("family") == "inet"]
    if len(present) != 1 or str(ipaddress.ip_interface(
           present[0]["local"] + "/" + str(present[0]["prefixlen"])).network) != plan["networkCidr"]:
        raise RuntimeError("Observed management bridge subnet differs from preflight")
    defaults = [r for r in routes if r.get("dst") in ("default", "0.0.0.0/0")]
    if len(defaults) != 1 or defaults[0].get("dev") != br or defaults[0].get("gateway") != plan["gateway"]:
        raise RuntimeError("Managed bridge has lost verified default gateway")
    # Prove RP can still authenticate this enrolled Gate after migration.
    conf = read_control_config()
    request = urllib.request.Request(
        conf["apiUrl"].rstrip("/") + "/networking/gates/agent/config",
        headers={"Authorization": "Bearer " + conf["agentToken"]})
    with urllib.request.urlopen(request, timeout=12) as response:
        if response.status != 200 or json.load(response).get("gateId") != plan["gateId"]:
            raise RuntimeError("RP Gate control plane authentication failed")
    return True


def confirm():
    plan = load_checkpoint()
    if time.time() - plan["checkedAt"] > 600:
        raise ValueError("Confirmation deadline expired; use rollback")
    verify(plan)
    # Mark the bridge owned only after the verified migration. The alias must
    # be set on the BRIDGE, not on the physical Ethernet interface.
    call("ip", "link", "set", "dev", plan["bridge"], "alias",
         "rp-lan:" + plan["gateId"] + ":" + plan["device"])
    verified = dict(gateId=plan["gateId"], device=plan["device"], bridge=plan["bridge"],
                    state="Ready", rollbackTested=True, verifiedAt=time.time(),
                    networkCidr=plan["networkCidr"],gateway=plan["gateway"])
    write(STATE / "managed-uplink.json", json.dumps(verified))
    checkpoint_file().unlink()
    call("systemctl", "disable", "--now", WATCH + ".timer")
    return verified


def refresh():
    """Authenticated periodic re-attestation, never a substitute for confirm."""
    if checkpoint_file().exists():
        raise ValueError("Managed uplink is pending migration confirmation")
    path = STATE / "managed-uplink.json"
    if not path.is_file() or path.is_symlink():
        raise ValueError("Managed uplink has not been confirmed")
    current = json.loads(path.read_text())
    if current.get("state") != "Ready" or current.get("rollbackTested") is not True:
        raise ValueError("Managed uplink is not certified Ready")
    plan = {"gateId": current["gateId"], "device": current["device"],
            "bridge": current["bridge"], "networkCidr": current["networkCidr"],
            "gateway": current.get("gateway")}
    if not plan["gateway"]:
        # Older proofs do not persist the network gateway, so no stale
        # state may be upgraded into a new authorization.
        raise ValueError("Managed uplink requires gateway-bound confirmation")
    verify(plan)
    # The ephemeral kernel alias disappears on reboot, while networkd owns
    # persistent bridge configuration. Restore the RP-only ownership marker
    # once the live physical NIC, subnet, route and control auth are verified.
    call("ip", "link", "set", "dev", plan["bridge"], "alias",
         "rp-lan:" + plan["gateId"] + ":" + plan["device"])
    current["verifiedAt"] = time.time()
    write(path, json.dumps(current, sort_keys=True))
    return current


def rollback():
    if not checkpoint_file().exists():
        return
    plan = load_checkpoint()
    if plan.get("protocol") != 1 or not UUID.fullmatch(plan.get("gateId", "")) or not DEVICE.fullmatch(plan.get("device", "")):
        raise ValueError("Refusing unsafe rollback checkpoint")
    if plan.get("bridge") != bridge_name(plan["gateId"], plan["device"]):
        raise ValueError("Rollback bridge identity mismatch")
    original = Path(plan["originalPath"])
    if original.parent != NETWORKD or not NETWORK_FILE.fullmatch(original.name) or original.is_symlink():
        raise ValueError("Rollback path is outside supported networkd directory")
    write(original, plan["originalText"], plan["originalMode"])
    for suffix in (".netdev", ".network"):
        path = NETWORKD / ("09-" + plan["bridge"] + suffix)
        if path.is_symlink():
            raise ValueError("Refusing to remove symlinked networkd resource")
        path.unlink(missing_ok=True)
    (STATE / "managed-uplink.json").unlink(missing_ok=True)
    # Files are restored durably before touching link state.
    call("networkctl", "reload")
    call("networkctl", "reconfigure", plan["device"])
    checkpoint_file().unlink()
    # Keep the watchdog enabled if recovery could not restore the link. Only
    # successful rollback reaches this point and disables the timer.
    call("systemctl", "disable", "--now", WATCH + ".timer")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("preflight", "apply", "confirm", "refresh", "rollback", "status"))
    parser.add_argument("--device")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("RP managed uplink requires root")
    if args.action in ("preflight", "apply"):
        if not args.device:
            raise ValueError("--device is mandatory")
        plan = preflight(args.device)
        if args.action == "apply":
            arm(plan)
        print(json.dumps({k: v for k, v in plan.items() if k not in ("originalText",)}, sort_keys=True))
    elif args.action == "rollback":
        rollback()
    elif args.action == "refresh":
        print(json.dumps(refresh(), sort_keys=True))
    elif args.action == "confirm":
        print(json.dumps(confirm(), sort_keys=True))
    else:
        proof = STATE / "managed-uplink.json"
        print(proof.read_text() if proof.is_file() else '{"state":"Unconfigured"}')


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("RP Gate managed uplink: " + str(exc), file=sys.stderr)
        sys.exit(1)
