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
        eth.get("dhcp4") is not True or eth.get("dhcp6", False) is not False):
        raise ValueError("Only Netplan/NetworkManager DHCPv4 Ethernet is supported")
    allowed = {"renderer", "dhcp4", "dhcp6", "optional", "accept-ra", "link-local"}
    if any(k not in allowed for k in eth) or eth.get("accept-ra", False) is not False:
        raise ValueError("Customized Netplan Ethernet requires a tailored migration")
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
    plan = {"protocol": 1, "manager": "NetplanNetworkManager",
            "gateId": gate, "device": device, "bridge": br, "bridgeMac": mac,
            "routeMetric": default.get("metric", 0),
            "networkCidr": str(address.network), "gateway": str(gateway),
            "checkedAt": time.time(), "state": "Preflight"}
    netplan_override(plan)
    return plan


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
    timer = ("[Unit]\nDescription=Rollback unconfirmed RP Gate Ethernet migration\n"
             "[Timer]\nOnActiveSec=120s\nOnBootSec=120s\nOnUnitActiveSec=60s\nAccuracySec=1s\n"
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
        if plan.get("manager") == "NetplanNetworkManager":
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
    if plan.get("manager") == "NetplanNetworkManager":
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
        if plan.get("manager") == "NetplanNetworkManager" and route.get("metric", 0) != plan["routeMetric"]:
            raise ValueError("Netplan bridge changed route priority")
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
    if manager not in (None, "Networkd", "NetplanNetworkManager"):
        raise ValueError("Unknown managed uplink network manager")
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
