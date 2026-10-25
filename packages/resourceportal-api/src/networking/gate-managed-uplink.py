#!/usr/bin/env python3
"""ResourcePortal Gate managed shared Ethernet uplink.

Supported scopes: Debian/systemd-networkd or Netplan-managed NetworkManager
with an explicitly owned wired DHCPv4 NIC, stable gateway priority, and a
single /16..30 LAN. Wi-Fi may provide a higher-metric backup route, but is
NEVER bridged. No unmanaged NIC, global IPv6, VLAN trunk, competing dhcpcd,
ambiguous equal-priority route or foreign bridge is permitted.

The persistent watchdog is armed BEFORE any network changes. Local --confirm
must prove the post-migration bridge and the authenticated control plane.
Crash, reboot or nonconfirmation restores the exact old network configuration.
No tenant attachment can create or delete this host-owned bridge.
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
NETPLAN = Path("/etc/netplan")
SYSFS = Path("/sys/class/net")
SYSTEMD = Path("/etc/systemd/system")
TOOL = Path("/usr/local/sbin/resourceportal-gate-uplink")
WATCH = "resourceportal-gate-uplink-rollback"
DEVICE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$")
NETWORK_FILE = re.compile(r"^[A-Za-z0-9_.-]+\.network$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def call(*args: str) -> str:
    # Netplan apply may wait for NetworkManager DHCP; allow bounded recovery
    # while the independent 120-second watchdog is already armed.
    timeout = 60 if args == ("netplan", "apply") else 20
    if len(args) >= 3 and args[0] == "nmcli" and args[1] == "--wait":
        try:
            wait_seconds = int(args[2])
        except ValueError as exc:
            raise ValueError("Invalid bounded NetworkManager timeout") from exc
        if not 1 <= wait_seconds <= 60:
            raise ValueError("Unbounded NetworkManager command wait")
        timeout = wait_seconds + 10
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
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


def service_active(name: str) -> bool:
    return subprocess.run(("systemctl", "is-active", "--quiet", name),
                          check=False, capture_output=True, timeout=5).returncode == 0


def chosen_default(routes: list, interface: str, expected_gateway: str | None = None) -> dict:
    defaults = [r for r in routes if r.get("dst") in ("default", "0.0.0.0/0")]
    own = [r for r in defaults if r.get("dev") == interface]
    if len(own) != 1 or not own[0].get("gateway"):
        raise ValueError("Expected one DHCPv4 default gateway on managed Ethernet")
    route = own[0]
    if expected_gateway is not None and route["gateway"] != expected_gateway:
        raise ValueError("Observed default gateway changed")
    priority = route.get("metric", 0)
    if not isinstance(priority, int) or not 0 <= priority <= 65535:
        raise ValueError("Managed Ethernet routing metric invalid")
    for other in defaults:
        if other is route:
            continue
        metric = other.get("metric", 0)
        if not isinstance(metric, int) or metric <= priority:
            raise ValueError("Ambiguous or higher-priority competing host default route")
        # Other NICs may be backup connections but may not be other Ethernet
        # bridge devices on this same management interface.
        if other.get("dev") in (interface, "") or not other.get("gateway"):
            raise ValueError("Unsupported competing default route")
    return route


def netplan_override(plan: dict) -> str:
    # Render only hard-validated tokens. Never embed a tenant-provided path,
    # DNS server, gateway or profile command into a root-written YAML file.
    if plan.get("bridge") != bridge_name(plan["gateId"], plan["device"]):
        raise ValueError("Invalid RP-owned bridge identity")
    if not re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", plan["bridgeMac"]):
        raise ValueError("Invalid hardware bridge MAC")
    metric = plan["routeMetric"]
    if not isinstance(metric, int) or not 0 <= metric <= 65535:
        raise ValueError("Unsafe Netplan route priority")
    dev, br = plan["device"], plan["bridge"]
    return (f"network:\n  version: 2\n  renderer: NetworkManager\n"
            f"  ethernets:\n    {dev}:\n      dhcp4: false\n"
            f"      dhcp6: false\n      accept-ra: false\n      link-local: []\n"
            f"  bridges:\n    {br}:\n      interfaces: [{dev}]\n"
            f"      dhcp4: true\n      dhcp6: false\n      accept-ra: false\n"
            f"      link-local: []\n"
            f"      macaddress: {plan['bridgeMac']}\n"
            f"      dhcp4-overrides:\n        route-metric: {metric}\n"
            f"      parameters:\n        stp: false\n")


def netplan_config_file(plan: dict) -> Path:
    if plan["bridge"] != bridge_name(plan["gateId"], plan["device"]):
        raise ValueError("Invalid Netplan bridge identity")
    return NETPLAN / ("99-resourceportal-" + plan["bridge"] + ".yaml")


def raspberry_pi_os_netplan_rewrite_risk() -> bool:
    # Raspberry Pi OS's patched NetworkManager may regenerate /etc/netplan
    # and discard the RP-owned drop-in. Our original-file-free rollback is
    # NOT sufficient there, and netplan apply may leave kernel bridges behind.
    # Do not arm the timer or mutate the host until recovery is certified.
    return "rpt-rpi" in os.uname().release.lower()



def native_nm_uuid(gate: str, device: str, role: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL,
                         "resourceportal-gate-uplink:" + gate + ":" + device + ":" + role))


def native_nm_port(plan: dict) -> str:
    return "rp-port-" + plan["bridge"][6:]


def native_nm_recovery(plan: dict) -> str:
    return "rp-recovery-" + plan["bridge"][6:]


def native_nm_original(plan: dict) -> str:
    value = plan.get("originalUuid", "")
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("Missing original NetworkManager connection UUID")
    if value in (plan.get("bridgeUuid"), plan.get("portUuid")):
        raise ValueError("NetworkManager bridge would overwrite original Ethernet")
    return value


def native_nm_identity(plan: dict) -> None:
    """No foreign profiles, port ownership or unverified aliases may be changed."""
    if plan["bridge"] != bridge_name(plan["gateId"], plan["device"]):
        raise ValueError("Unsafe RP Gate bridge identifier")
    for role, key in (("bridge", "bridgeUuid"), ("port", "portUuid")):
        expected = native_nm_uuid(plan["gateId"], plan["device"], role)
        if plan.get(key) != expected:
            raise ValueError("Unsafe NetworkManager " + role + " UUID")
    native_nm_original(plan)


def nm_connection_exists(uid: str) -> bool:
    # Failed lookups are normal when an operation is interrupted between steps.
    return subprocess.run(("nmcli", "-g", "connection.uuid", "connection", "show", uid),
                          capture_output=True, timeout=5, check=False).returncode == 0


def nm_connection_matches(uid: str, expected_name: str, expected_type: str) -> bool:
    if not nm_connection_exists(uid):
        return False
    name = call("nmcli", "-g", "connection.id", "connection", "show", uid)
    category = call("nmcli", "-g", "connection.type", "connection", "show", uid)
    return name == expected_name and category == expected_type


def native_nm_profile_state(plan: dict, require_bridge: bool = False):
    native_nm_identity(plan)
    b, p = plan["bridgeUuid"], plan["portUuid"]
    if nm_connection_exists(b) and not nm_connection_matches(b, plan["bridge"], "bridge"):
        raise ValueError("Refusing a foreign NetworkManager bridge profile")
    if nm_connection_exists(p) and not nm_connection_matches(p, native_nm_port(plan), "802-3-ethernet"):
        raise ValueError("Refusing a foreign NetworkManager port profile")
    if require_bridge and (not nm_connection_exists(b) or not nm_connection_exists(p)):
        raise RuntimeError("Persistent NetworkManager bridge profiles are missing")


def apply_native_networkmanager(plan: dict):
    """Use NetworkManager's native connection writer, NEVER netplan apply.

    Raspberry Pi OS NM can replace Netplan YAML when saving its profiles.
    Profiles are therefore created through NM (which owns their persistence).
    The prior wired profile survives and is re-enabled on rollback. The
    watchdog and separate verifier run even if the invoking SSH session dies.
    """
    native_nm_profile_state(plan)
    original = native_nm_original(plan)
    if not nm_connection_matches(original, plan["originalName"], "802-3-ethernet"):
        raise ValueError("Original NetworkManager Ethernet profile changed")
    if nm_connection_exists(plan["bridgeUuid"]) or nm_connection_exists(plan["portUuid"]):
        raise ValueError("Refusing partial or pre-existing managed NM profile state")
    br, port, mac = plan["bridge"], native_nm_port(plan), plan["bridgeMac"]
    call("nmcli", "connection", "add", "type", "bridge",
         "ifname", br, "con-name", br,
         "connection.uuid", plan["bridgeUuid"],
         "connection.autoconnect", "yes",
         "connection.autoconnect-priority", str(plan["portPriority"]),
         "bridge.stp", "no", "bridge.mac-address", mac,
         "ipv4.method", "auto", "ipv4.route-metric", str(plan["routeMetric"]),
         "ipv6.method", "disabled")
    call("nmcli", "connection", "add", "type", "ethernet",
         "ifname", plan["device"], "con-name", port,
         "connection.uuid", plan["portUuid"],
         "connection.autoconnect", "yes",
         "connection.autoconnect-priority", str(plan["portPriority"]),
         "ipv4.method", "disabled", "ipv6.method", "disabled",
         "master", br, "slave-type", "bridge")
    # Do NOT modify original netplan-eth0. Pi OS patched NetworkManager
    # regenerates /etc/netplan on edits of a netplan-prefixed connection.
    # Instead the new persistent RP port gets higher autoconnect priority;
    # original DHCP profile remains available for rollback and manual rescue.
    call("nmcli", "--wait", "15", "connection", "down", "uuid", original)
    # Activating a bridge port activates its bridge controller. The bridge's
    # DHCPv4 transaction acquires the original MAC and should regain the lease.
    call("nmcli", "--wait", "35", "connection", "up", "uuid", plan["portUuid"])


def nm_live_profile_uuid(device: str) -> str:
    return call("nmcli", "-g", "GENERAL.CON-UUID", "device", "show", device).lower()


def rollback_native_networkmanager(plan: dict):
    """Watchdog-safe idempotent recovery via saved original wired NM profile."""
    if not service_active("NetworkManager") or service_active("systemd-networkd"):
        raise ValueError("NetworkManager ownership changed during recovery")
    native_nm_profile_state(plan)
    original = native_nm_original(plan)
    b, p = plan["bridgeUuid"], plan["portUuid"]
    # The original netplan-prefixed connection is NEVER modified on apply:
    # keeping it intact avoids Pi OS Netplan YAML regeneration. If missing
    # after an unrelated NM rewrite, create a minimal separate DHCP recovery.
    if nm_connection_exists(original):
        if not (nm_connection_matches(original, plan["originalName"], "802-3-ethernet") or
                nm_connection_matches(original, native_nm_recovery(plan), "802-3-ethernet")):
            raise ValueError("Original wired profile was replaced")
    else:
        # A Pi OS NetworkManager rebuild may remove the original Netplan
        # profile entirely. Recreate a minimal wired DHCP recovery connection,
        # retaining the hardware and the original UUID identity on disk.
        call("nmcli", "connection", "add", "type", "ethernet",
             "ifname", plan["device"], "con-name", native_nm_recovery(plan),
             "connection.uuid", original, "connection.autoconnect", "yes",
             "ipv4.method", "auto", "ipv4.route-metric", str(plan["routeMetric"]),
             "ipv6.method", "disabled")
    # Quiesce RP-owned port first; never delete a bridge with foreign members.
    links = json.loads(call("ip", "-j", "-d", "link", "show"))
    bridge = next((x for x in links if x.get("ifname") == plan["bridge"]), None)
    if bridge:
        member_names = [x["ifname"] for x in links if x.get("master") == plan["bridge"]]
        owner = "rp-lan:" + plan["gateId"] + ":" + plan["device"]
        if (bridge.get("linkinfo", {}).get("info_kind") != "bridge" or
                bridge.get("ifalias") not in (None, "", owner) or
                any(x != plan["device"] for x in member_names)):
            raise ValueError("Refusing to destroy a foreign LAN bridge")
    if nm_connection_exists(p):
        subprocess.run(("nmcli", "--wait", "10", "connection", "down", "uuid", p),
                       check=False, capture_output=True, timeout=20)
    if nm_connection_exists(b):
        subprocess.run(("nmcli", "--wait", "10", "connection", "down", "uuid", b),
                       check=False, capture_output=True, timeout=20)
    call("nmcli", "--wait", "35", "connection", "up", "uuid", original,
         "ifname", plan["device"])
    links, addresses, routes = snapshot()
    member = next((x for x in links if x.get("ifname") == plan["device"]), None)
    if not member or member.get("master"):
        raise RuntimeError("NetworkManager did not restore standalone Ethernet")
    ips = [a for x in addresses if x.get("ifname") == plan["device"] for a in x.get("addr_info", [])
           if a.get("family") == "inet" and a.get("scope") != "host"]
    if (len(ips) != 1 or str(ipaddress.ip_interface(
            ips[0]["local"] + "/" + str(ips[0]["prefixlen"])).network) != plan["networkCidr"]):
        raise RuntimeError("Wired DHCP subnet was not restored")
    chosen_default(routes, plan["device"], plan["gateway"])
    # Delete solely deterministic RP profiles after wired management is restored.
    if nm_connection_exists(p):
        call("nmcli", "connection", "delete", "uuid", p)
    if nm_connection_exists(b):
        call("nmcli", "connection", "delete", "uuid", b)
    # An orphan kernel bridge can survive NM profile deletion; remove only the
    # verified RP-generated bridge with no attached ports or foreign alias.
    links = json.loads(call("ip", "-j", "-d", "link", "show"))
    old = next((x for x in links if x.get("ifname") == plan["bridge"]), None)
    if old:
        owner = "rp-lan:" + plan["gateId"] + ":" + plan["device"]
        if (old.get("linkinfo", {}).get("info_kind") != "bridge" or
            old.get("ifalias") not in (None, "", owner) or
            any(x.get("master") == plan["bridge"] for x in links)):
            raise ValueError("Refusing foreign bridge cleanup after DHCP recovery")
        call("ip", "link", "set", "dev", plan["bridge"], "down")
        call("ip", "link", "delete", "dev", plan["bridge"], "type", "bridge")
    (STATE / "managed-uplink.json").unlink(missing_ok=True)
    checkpoint_file().unlink()
    call("systemctl", "disable", "--now", WATCH + ".timer")


def auto_confirm():
    """Independent systemd recovery verifier, survives caller SSH disconnect."""
    for attempt in range(36):
        if not checkpoint_file().exists():
            return
        try:
            confirm()
            return
        except Exception:
            if attempt == 35:
                raise
            time.sleep(2)

def preflight_networkmanager(device: str, gate: str, br: str) -> dict:
    # Netplan (rather than an ephemeral nmcli connection profile) is the
    # source of truth on this Raspberry Pi. Pure NetworkManager configurations
    # must NOT be rewritten as if they came from Netplan.
    if not service_active("NetworkManager") or service_active("dhcpcd") or service_active("systemd-networkd"):
        raise ValueError("Netplan bridge migration requires exclusive NetworkManager")
    try:
        import yaml
    except ImportError as exc:
        raise ValueError("Netplan preflight requires python3-yaml") from exc
    profile = call("nmcli", "-g", "GENERAL.CONNECTION", "device", "show", device)
    if profile != "netplan-" + device:
        raise ValueError("Interface is not owned by an exact Netplan Ethernet profile")
    cfg = yaml.safe_load(call("netplan", "get"))
    if not isinstance(cfg, dict) or not isinstance(cfg.get("network"), dict):
        raise ValueError("Unable to read merged Netplan configuration")
    network = cfg["network"]
    # The RP override contains a global renderer. Never promote an originally
    # mixed-renderer host to NetworkManager: unrelated NICs could disappear.
    if network.get("renderer") != "NetworkManager":
        raise ValueError("Netplan must already use NetworkManager as the global renderer")
    eth = network.get("ethernets", {}).get(device)
    if not isinstance(eth, dict) or (eth.get("renderer", "NetworkManager") != "NetworkManager" or
        eth.get("dhcp4") is not True or type(eth.get("dhcp6", False)) is not bool):
        raise ValueError("Only Netplan/NetworkManager DHCPv4 Ethernet is supported")
    # Raspberry Pi OS 13 materializes netplan-eth0 from NetworkManager,
    # including dhcp6:true and bookkeeping. The live global-IPv6 check below
    # is authoritative; an idle DHCPv6 *setting* is not an IPv6 lease.
    allowed = {"renderer", "dhcp4", "dhcp6", "optional", "accept-ra", "link-local",
               "match", "networkmanager"}
    if (any(k not in allowed for k in eth) or
            eth.get("accept-ra", False) is not False or
            eth.get("match", {}) != {}):
        raise ValueError("Customized Netplan Ethernet requires a tailored migration")
    nm = eth.get("networkmanager")
    if nm is not None:
        if not isinstance(nm, dict) or set(nm) != {"uuid", "name", "passthrough"}:
            raise ValueError("Unsupported NetworkManager metadata keys")
        if (not isinstance(nm["uuid"], str) or not UUID.fullmatch(nm["uuid"]) or
                nm["name"] != "netplan-" + device or
                nm["passthrough"] not in ({}, {"proxy._": ""})):
            raise ValueError("Unsafe NetworkManager profile metadata")
        runtime_uuid = call("nmcli", "-g", "GENERAL.CON-UUID", "device", "show", device)
        if runtime_uuid.lower() != nm["uuid"].lower():
            raise ValueError("Netplan profile UUID does not match connected Ethernet")
    if device in network.get("bridges", {}) or network.get("bonds") or network.get("vlans"):
        raise ValueError("Existing host bridge, bond or VLAN configuration is unsupported")
    links, addresses, routes = snapshot()
    physical = next((x for x in links if x.get("ifname") == device), None)
    if (not physical or physical.get("link_type") != "ether" or
        physical.get("linkinfo", {}).get("info_kind") or physical.get("master") or
        physical.get("operstate") != "UP" or any(x.get("ifname") == br for x in links)):
        raise ValueError("Unsafe physical Ethernet or foreign bridge ownership")
    mac = physical.get("address", "").lower()
    if not re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", mac) or int(mac[:2],16) & 1:
        raise ValueError("Physical management Ethernet has an invalid MAC")
    active = [a for x in addresses if x.get("ifname") == device for a in x.get("addr_info", [])
              if a.get("family") == "inet" and a.get("scope") != "host"]
    ipv6 = [a for x in addresses if x.get("ifname") == device for a in x.get("addr_info", [])
            if a.get("family") == "inet6" and a.get("scope") != "link"]
    if len(active) != 1 or ipv6:
        raise ValueError("Netplan uplink requires one DHCPv4 and no global IPv6")
    # A DHCPv6 option without a live IPv6 route is permitted for read-only
    # preflight; we still reject a working IPv6 default before migration.
    ipv6_defaults = json.loads(call("ip", "-6", "-j", "route", "show", "default") or "[]")
    if not isinstance(ipv6_defaults, list) or ipv6_defaults:
        raise ValueError("IPv6 default route is active on this host")
    address = ipaddress.ip_interface(active[0]["local"] + "/" + str(active[0]["prefixlen"]))
    if not 16 <= address.network.prefixlen <= 30:
        raise ValueError("Netplan management subnet is outside /16..30")
    default = chosen_default(routes, device)
    gateway = ipaddress.ip_address(default["gateway"])
    if gateway not in address.network or gateway in (address.network.network_address,
                                                        address.network.broadcast_address):
        raise ValueError("Netplan management gateway is not on-link")
    path = NETPLAN / ("99-resourceportal-" + br + ".yaml")
    if path.exists() or path.is_symlink():
        raise ValueError("RP Netplan bridge override already exists")
    # On Raspberry Pi OS the patched NetworkManager can rewrite /etc/netplan;
    # use NM's own persistent connection API instead of a fragile YAML drop-in.
    native = raspberry_pi_os_netplan_rewrite_risk()
    plan = {"protocol": 1, "manager": "NativeNetworkManager" if native else "NetplanNetworkManager",
            "gateId": gate, "device": device, "bridge": br, "bridgeMac": mac,
            "routeMetric": default.get("metric", 0),
            "networkCidr": str(address.network), "gateway": str(gateway),
            "checkedAt": time.time(), "state": "Preflight",
            "requiresOutOfBandRecovery": True,
            "applySupported": True}
    if native:
        original_uuid = call("nmcli", "-g", "GENERAL.CON-UUID", "device", "show", device).lower()
        if not UUID.fullmatch(original_uuid):
            raise ValueError("Ethernet NetworkManager profile has no stable UUID")
        original_name = call("nmcli", "-g", "GENERAL.CONNECTION", "device", "show", device)
        if not nm_connection_matches(original_uuid, original_name, "802-3-ethernet"):
            raise ValueError("Connected NetworkManager Ethernet profile changed")
        original_auto = call("nmcli", "-g", "connection.autoconnect",
                             "connection", "show", original_uuid)
        if original_auto.strip().lower() not in ("yes", "true"):
            raise ValueError("Wired Ethernet must autoconnect for crash recovery")
        original_priority = int(call("nmcli", "-g", "connection.autoconnect-priority",
                                     "connection", "show", original_uuid))
        if not -999 <= original_priority < 999:
            raise ValueError("Original Ethernet autoconnect priority is unsupported")
        plan.update(originalUuid=original_uuid, originalName=original_name,
                    portPriority=min(999, original_priority + 50),
                    bridgeUuid=native_nm_uuid(gate, device, "bridge"),
                    portUuid=native_nm_uuid(gate, device, "port"))
        native_nm_identity(plan)
        native_nm_profile_state(plan)
    if not native:
        netplan_override(plan)
    return plan


def ethernet_candidates() -> list[str]:
    # Physical, carrier-up Ethernet only. Never select Wi-Fi (including
    # 802.11-station interfaces, which Linux also calls link_type=ether),
    # VLAN, virtual adapters, existing bridge slaves or RP WireGuard.
    links = json.loads(call("ip", "-j", "-d", "link", "show"))
    result = []
    for row in links:
        dev = row.get("ifname", "")
        if not DEVICE.fullmatch(dev) or dev in ("lo", "docker0", "rp-gate"):
            continue
        if (row.get("link_type") != "ether" or row.get("master") or
                row.get("linkinfo", {}).get("info_kind") or
                row.get("operstate") != "UP"):
            continue
        sysif = SYSFS / dev
        # Platform Ethernet on Raspberry Pi (bcmgenet) does not always
        # expose the same "device" symlink as PCI Ethernet cards. Check the
        # resolved sysfs ancestry instead and exclude /devices/virtual/net.
        if (not sysif.exists() or (sysif / "wireless").exists() or
                "/virtual/net/" in str(sysif.resolve())):
            continue
        result.append(dev)
    return sorted(result)


def preflight(device: str) -> dict:
    if not DEVICE.fullmatch(device) or device in ("lo", "rp-gate", "docker0"):
        raise ValueError("Unsafe management Ethernet identity")
    config = read_control_config()
    gate = config["gateId"]
    br = bridge_name(gate, device)
    if service_active("NetworkManager"):
        return preflight_networkmanager(device, gate, br)
    if service_active("dhcpcd"):
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
    return {"protocol": 1, "manager": "Networkd", "gateId": gate,
            "device": device, "bridge": br, "applySupported": True,
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
    timer = ("[Unit]\nDescription=Rollback unconfirmed RP Gate Ethernet migration\n"
             "[Timer]\nOnActiveSec=120s\nOnBootSec=120s\nOnUnitActiveSec=60s\nAccuracySec=1s\n"
             "Unit=" + WATCH + ".service\n"
             "[Install]\nWantedBy=timers.target\n")
    return service, timer


def auto_confirm_unit() -> str:
    # Detached systemd verification survives disconnection of installation SSH.
    return chr(10).join(("[Unit]", "Description=Confirm authenticated RP Gate Ethernet bridge",
                         "After=NetworkManager.service", "[Service]", "Type=oneshot",
                         "ExecStart=" + str(TOOL) + " auto-confirm",
                         "TimeoutStartSec=100", ""))


def migrate_unit() -> str:
    # NetworkManager takeover of the SSH NIC must NOT depend on the SSH
    # session surviving the first successful nmcli connection down.
    return chr(10).join(("[Unit]", "Description=Apply RP Gate Ethernet bridge migration",
                         "After=NetworkManager.service", "[Service]", "Type=oneshot",
                         "ExecStart=" + str(TOOL) + " migrate",
                         "TimeoutStartSec=95", ""))


def migrate():
    plan = load_checkpoint()
    if plan.get("manager") != "NativeNetworkManager":
        raise ValueError("Native NetworkManager migration is not pending")
    try:
        apply_native_networkmanager(plan)
    except Exception:
        # Watchdog checkpoint is intentionally retained on incomplete rollback.
        rollback()
        raise


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
    write(SYSTEMD / ("resourceportal-gate-uplink-autoconfirm.service"), auto_confirm_unit())
    write(SYSTEMD / ("resourceportal-gate-uplink-migrate.service"), migrate_unit())
    write(checkpoint_file(), json.dumps(plan, sort_keys=True))
    try:
        call("systemctl", "daemon-reload")
        call("systemctl", "enable", "--now", WATCH + ".timer")
        if call("systemctl", "is-active", WATCH + ".timer") != "active":
            raise RuntimeError("Rollback watchdog is not armed")
        # Start verification as a detached systemd job BEFORE reparenting the
        # management NIC; it can complete when the installer SSH disappears.
        call("systemctl", "start", "--no-block", "resourceportal-gate-uplink-autoconfirm.service")
        if plan.get("manager") == "NativeNetworkManager":
            # Detached systemd job, so an SSH transport reset cannot kill the
            # actual link migration halfway. Watchdog remains independent.
            call("systemctl", "start", "--no-block", "resourceportal-gate-uplink-migrate.service")
        elif plan.get("manager") == "NetplanNetworkManager":
            path = netplan_config_file(plan)
            if path.exists() or path.is_symlink():
                raise ValueError("Refusing existing Netplan override")
            write(path, netplan_override(plan), mode=0o600)
            # Netplan is the declarative owner of NetworkManager profiles,
            # including the Wi-Fi backup. No direct nmcli mutation persists.
            call("netplan", "generate")
            call("netplan", "apply")
        else:
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
    if plan.get("manager") == "NativeNetworkManager":
        native_nm_profile_state(plan, require_bridge=True)
        if (nm_live_profile_uuid(br) != plan["bridgeUuid"] or
                nm_live_profile_uuid(plan["device"]) != plan["portUuid"]):
            raise RuntimeError("NetworkManager active bridge/port UUIDs differ from checkpoint")
        if call("nmcli", "-g", "connection.master", "connection", "show",
                plan["portUuid"]) not in (br, plan["bridgeUuid"]):
            raise RuntimeError("NetworkManager port is not owned by the RP bridge")
    elif plan.get("manager") == "NetplanNetworkManager":
        conf = netplan_config_file(plan)
        if not conf.is_file() or conf.is_symlink() or conf.read_text() != netplan_override(plan):
            raise RuntimeError("RP-owned persistent NetworkManager/Netplan bridge config not found")
    else:
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
    try:
        route = chosen_default(routes, br, plan["gateway"])
        if plan.get("manager") in ("NativeNetworkManager", "NetplanNetworkManager") and route.get("metric", 0) != plan["routeMetric"]:
            raise ValueError("NetworkManager bridge changed route priority")
    except ValueError as exc:
        raise RuntimeError("Managed bridge lost safe default routing: " + str(exc)) from exc
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
                    networkCidr=plan["networkCidr"], gateway=plan["gateway"])
    if plan.get("manager") == "NativeNetworkManager":
        verified.update(manager="NativeNetworkManager", bridgeMac=plan["bridgeMac"],
                        routeMetric=plan["routeMetric"],
                        originalUuid=plan["originalUuid"], originalName=plan["originalName"],
                        bridgeUuid=plan["bridgeUuid"], portUuid=plan["portUuid"])
    if plan.get("manager") == "NetplanNetworkManager":
        # A periodic refresh must verify the same persistent Netplan plan as
        # confirm. Without these fields it silently checks networkd instead.
        verified.update(manager="NetplanNetworkManager", bridgeMac=plan["bridgeMac"],
                        routeMetric=plan["routeMetric"])
    write(STATE / "managed-uplink.json", json.dumps(verified, sort_keys=True))
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
    manager = current.get("manager")
    if manager not in (None, "Networkd", "NetplanNetworkManager", "NativeNetworkManager"):
        raise ValueError("Unknown managed uplink network manager")
    if manager == "NativeNetworkManager":
        for key in ("originalUuid", "bridgeUuid", "portUuid", "originalName"):
            if not isinstance(current.get(key), str) or not current[key]:
                raise ValueError("NetworkManager proof lacks immutable profile identity")
        if not isinstance(current.get("bridgeMac"), str) or type(current.get("routeMetric")) is not int:
            raise ValueError("NetworkManager proof lacks MAC or route priority")
        plan.update(manager=manager, bridgeMac=current["bridgeMac"], routeMetric=current["routeMetric"],
                    originalUuid=current["originalUuid"], originalName=current["originalName"],
                    bridgeUuid=current["bridgeUuid"], portUuid=current["portUuid"])
    if manager == "NetplanNetworkManager":
        if not isinstance(current.get("bridgeMac"), str) or type(current.get("routeMetric")) is not int:
            raise ValueError("NetworkManager proof lacks bridge MAC or route priority")
        plan.update(manager=manager, bridgeMac=current["bridgeMac"],
                    routeMetric=current["routeMetric"])
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


def rollback_networkmanager(plan: dict):
    """Restore the old declarative Netplan state without touching Wi-Fi.

    The original Netplan files are never overwritten. The watchdog removes
    only the exact RP-owned drop-in and retries until eth0 obtains DHCP again.
    """
    if not service_active("NetworkManager") or service_active("systemd-networkd"):
        raise ValueError("NetworkManager ownership changed during rollback")
    path = netplan_config_file(plan)
    if path.is_symlink() or (path.exists() and path.read_text() != netplan_override(plan)):
        raise ValueError("Refusing to remove a foreign Netplan configuration")
    links = json.loads(call("ip", "-j", "-d", "link", "show"))
    bridge = next((x for x in links if x.get("ifname") == plan["bridge"]), None)
    if bridge:
        owner = "rp-lan:" + plan["gateId"] + ":" + plan["device"]
        # NetworkManager may unslave eth0 *before* deleting the bridge. That
        # orphaned RP configuration must not block automated recovery.
        # We never delete a kernel device here: that remains NM's job.
        members = [x["ifname"] for x in links if x.get("master") == plan["bridge"]]
        if (bridge.get("linkinfo", {}).get("info_kind") != "bridge" or
                bridge.get("ifalias") not in ("", None, owner) or
                any(member != plan["device"] for member in members)):
            raise ValueError("Refusing unverified bridge cleanup in Netplan rollback")
    path.unlink(missing_ok=True)
    # A rollback interruption is recoverable because this checkpoint stays
    # on disk until the original IPv4 route has actually been verified.
    call("netplan", "generate")
    call("netplan", "apply")
    links, addresses, routes = snapshot()
    member = next((x for x in links if x.get("ifname") == plan["device"]), None)
    if not member or member.get("master"):
        raise RuntimeError("Ethernet still enslaved after Netplan rollback")
    ips = [a for x in addresses if x.get("ifname") == plan["device"] for a in x.get("addr_info", [])
           if a.get("family") == "inet" and a.get("scope") != "host"]
    if len(ips) != 1 or str(ipaddress.ip_interface(
            ips[0]["local"] + "/" + str(ips[0]["prefixlen"])).network) != plan["networkCidr"]:
        raise RuntimeError("Netplan rollback has not restored Ethernet DHCPv4")
    chosen_default(routes, plan["device"], plan["gateway"])
    # Kernel bridge cleanup is intentionally left to NetworkManager. An RP
    # bridge remaining after Netplan removes its profile is a failure, NOT
    # an authorization to delete arbitrary ports on the host.
    if any(x.get("ifname") == plan["bridge"] for x in links):
        raise RuntimeError("NetworkManager has not removed the old bridge")
    (STATE / "managed-uplink.json").unlink(missing_ok=True)
    checkpoint_file().unlink()
    call("systemctl", "disable", "--now", WATCH + ".timer")


def rollback():
    if not checkpoint_file().exists():
        return
    plan = load_checkpoint()
    if plan.get("protocol") != 1 or not UUID.fullmatch(plan.get("gateId", "")) or not DEVICE.fullmatch(plan.get("device", "")):
        raise ValueError("Refusing unsafe rollback checkpoint")
    if plan.get("bridge") != bridge_name(plan["gateId"], plan["device"]):
        raise ValueError("Rollback bridge identity mismatch")
    if plan.get("manager") == "NativeNetworkManager":
        rollback_native_networkmanager(plan)
        return
    if plan.get("manager") == "NetplanNetworkManager":
        rollback_networkmanager(plan)
        return
    if plan.get("manager") not in (None, "Networkd"):
        raise ValueError("Unknown checkpoint network manager")
    original = Path(plan["originalPath"])
    if original.parent != NETWORKD or not NETWORK_FILE.fullmatch(original.name) or original.is_symlink():
        raise ValueError("Rollback path is outside supported networkd directory")
    # A .netdev deletion alone does not remove its live kernel bridge.
    # Capture exact RP configuration ownership before removing files; an
    # unrelated bridge reusing the deterministic name must never be deleted.
    expected = config_files(plan)
    netdev = NETWORKD / ("09-" + plan["bridge"] + ".netdev")
    network = NETWORKD / ("09-" + plan["bridge"] + ".network")
    for path, contents in ((netdev, expected["netdev"]), (network, expected["bridge"])):
        if path.is_symlink():
            raise ValueError("Refusing to remove symlinked networkd resource")
        if path.exists() and path.read_text() != contents:
            raise ValueError("Refusing foreign managed bridge configuration")
    owned_netdev = netdev.is_file()
    # Inspect ownership while the exact RP-owned .netdev is still on disk.
    # Removing it before a failed link deletion would make the watchdog's
    # next attempt unable to authenticate its own bridge.
    links = json.loads(call("ip", "-j", "-d", "link", "show"))
    bridge = next((link for link in links if link.get("ifname") == plan["bridge"]), None)
    if bridge:
        parent = next((link for link in links if link.get("ifname") == plan["device"]), None)
        owner = "rp-lan:" + plan["gateId"] + ":" + plan["device"]
        if (not owned_netdev or bridge.get("linkinfo", {}).get("info_kind") != "bridge" or
                bridge.get("ifalias") not in (None, "", owner) or
                (not parent or parent.get("master") != plan["bridge"]) and bridge.get("ifalias") != owner):
            raise ValueError("Refusing to delete unverified or foreign managed bridge")
    # Restore the old management configuration before touching kernel links.
    # Keep the exact RP netdev configuration until deletion succeeds so a
    # watchdog retry can still authenticate the bridge after a failed delete.
    write(original, plan["originalText"], plan["originalMode"])
    if bridge:
        call("ip", "link", "set", "dev", plan["bridge"], "down")
        call("ip", "link", "delete", "dev", plan["bridge"], "type", "bridge")
    netdev.unlink(missing_ok=True)
    network.unlink(missing_ok=True)
    (STATE / "managed-uplink.json").unlink(missing_ok=True)
    call("networkctl", "reload")
    call("networkctl", "reconfigure", plan["device"])
    checkpoint_file().unlink()
    # Keep the watchdog enabled if recovery could not restore the link. Only
    # successful rollback reaches this point and disables the timer.
    call("systemctl", "disable", "--now", WATCH + ".timer")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("devices", "preflight", "apply", "migrate", "auto-confirm", "confirm", "refresh", "rollback", "status"))
    parser.add_argument("--device")
    parser.add_argument("--confirm-local-recovery", action="store_true",
                        help="Explicitly attest physical/out-of-band access for NetworkManager apply")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("RP managed uplink requires root")
    if args.action == "devices":
        print(json.dumps(ethernet_candidates()))
    elif args.action in ("preflight", "apply"):
        if not args.device:
            raise ValueError("--device is mandatory")
        plan = preflight(args.device)
        if args.action == "apply":
            if plan.get("manager") == "NativeNetworkManager":
                # The caller may lose SSH. Autoconfirmation occurs via systemd
                # only after actual network/L2 and RP authentication succeed.
                pass
            elif plan.get("manager") == "NetplanNetworkManager":
                if not plan.get("applySupported", True):
                    raise ValueError("Raspberry Pi OS NetworkManager rewrites /etc/netplan; "
                                     "rollback is not proven safe. Use dedicated LAN port "
                                     "or wait for certified migration.")
                if not args.confirm_local_recovery:
                    raise ValueError("NetworkManager management migration requires "
                                     "--confirm-local-recovery and physical/out-of-band access")
            arm(plan)
        print(json.dumps({k: v for k, v in plan.items() if k not in ("originalText",)}, sort_keys=True))
    elif args.action == "migrate":
        migrate()
    elif args.action == "auto-confirm":
        auto_confirm()
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
