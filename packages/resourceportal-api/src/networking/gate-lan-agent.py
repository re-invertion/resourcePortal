#!/usr/bin/env python3
"""Root-only, fail-closed RP Gate LAN attachment reconciler.

Input is an authenticated Gate agent config obtained over its existing HTTPS
machine token. The Gate management NIC must NEVER be enslaved to a bridge.
The controller intentionally supports dedicated unnumbered Ethernet/VLAN
handoff only; other topologies require a separately reviewed migration.
"""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

STATE = Path("/etc/resourceportal-gate/lan-state.json")
WG = "rp-gate"
MAC_RE = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
DEVICE_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$")


def call(*argv: str, ignore: bool = False) -> str:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=15, check=False)
    if result.returncode and not ignore:
        raise RuntimeError("%s failed: %s" % (argv[0], result.stderr.strip()[:350]))
    return result.stdout.strip()


def read_json(*argv: str) -> list[dict]:
    data = json.loads(call(*argv) or "[]")
    if not isinstance(data, list):
        raise ValueError("Invalid netlink snapshot")
    return data


def device_state():
    return (read_json("ip", "-j", "-d", "link", "show"),
            read_json("ip", "-j", "addr", "show"),
            read_json("ip", "-j", "route", "show", "table", "main"))


def identity(gate: str, tenant: str, attachment: str):
    for item in [gate, tenant, attachment]:
        uuid.UUID(item)
    return hashlib.sha256((tenant + ":" + gate + ":" + attachment).encode()).digest()


def names(gate: str, tenant: str, attachment: str, interface: str):
    digest = identity(gate, tenant, attachment)
    if not DEVICE_RE.fullmatch(interface):
        raise ValueError("Invalid physical LAN port")
    br = "rp-gb-" + hashlib.sha256((gate + ":" + interface).encode()).hexdigest()[:8]
    return ("rp-l2-" + digest[:4].hex(), br, "rp_" + digest.hex()[:12],
            str((int.from_bytes(digest[4:8], "big") % 4294967295) + 1))


def validate_link(interface: str, bridge: str, gate: str, links: list[dict],
                  addresses: list[dict], routes: list[dict]):
    link = next((i for i in links if i.get("ifname") == interface), None)
    existing = next((i for i in links if i.get("ifname") == bridge), None)
    if not link or link.get("link_type") != "ether" or link.get("operstate") != "UP":
        raise ValueError("LAN attachment requires a live dedicated Ethernet/VLAN interface")
    if link.get("linkinfo", {}).get("info_kind") not in (None, "vlan"):
        raise ValueError("LAN handoff cannot be a tunnel or bridge")
    if any(a.get("family") in ("inet", "inet6") for entry in addresses
           if entry.get("ifname") == interface for a in entry.get("addr_info", [])):
        raise ValueError("Gate LAN handoff has host addresses (management NIC)")
    if any(r.get("dev") == interface and r.get("dst") in ("default", "0.0.0.0/0", "::/0")
           for r in routes):
        raise ValueError("Gate LAN handoff carries a default route")
    alias = "rp-lan:" + gate + ":" + interface
    if existing:
        if existing.get("ifalias") != alias or existing.get("linkinfo", {}).get("info_kind") != "bridge" \
                or link.get("master") != bridge:
            raise ValueError("Refusing to adopt an unowned or malformed LAN bridge")
    elif link.get("master"):
        raise ValueError("LAN port belongs to another network master")
    return existing is not None


def underlay(config: dict):
    server = ipaddress.ip_interface(config["serverTunnelAddress"])
    client = ipaddress.ip_interface(config["tunnelAddress"])
    if server.version != 4 or client.version != 4 or server.network.prefixlen != 30 \
            or client.network.prefixlen != 30 or server.network != client.network \
            or server.ip == client.ip:
        raise ValueError("Invalid Gate WireGuard underlay /30")
    if server.ip in (server.network.network_address, server.network.broadcast_address) \
            or client.ip in (client.network.network_address, client.network.broadcast_address):
        raise ValueError("WireGuard underlay uses reserved /30 address")
    return str(client.ip), str(server.ip)


def is_handshake_recent(expected_peer: str):
    """Only the authenticated RP peer may authorize the customer's L2 bridge.

    A fresh handshake from an unrelated peer on the same interface must never
    authorize a LAN grant. Fail closed on malformed or duplicate peer output.
    """
    if not isinstance(expected_peer, str) or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", expected_peer):
        return False
    rows = call("wg", "show", WG, "latest-handshakes").splitlines()
    matches = [row.split() for row in rows if row.split()[:1] == [expected_peer]]
    if len(matches) != 1 or len(matches[0]) != 2:
        return False
    try:
        timestamp = int(matches[0][1])
    except ValueError:
        return False
    age = time.time() - timestamp
    return 0 <= age < 90


def nft_install(chain: str, tunnel: str, mac: str):
    # Create the owner-specific per-attachment ingress filter BEFORE the
    # GRETAP endpoint is attached to the customer's bridge.
    call("nft", "add", "table", "bridge", "rp_lan", ignore=True)
    call("nft", "add", "chain", "bridge", "rp_lan", chain,
         "{", "type", "filter", "hook", "forward", "priority", "-300", ";",
         "policy", "accept", ";", "}")
    for tail in [
        ("ether", "saddr", "!=", mac.lower(), "drop"),
        ("ether", "type", "vlan", "drop"),
        ("ether", "type", "0x88a8", "drop"),
        ("ether", "type", "ip6", "drop"),
        ("ether", "daddr", "01:80:c2:00:00:00", "drop"),
        ("ether", "type", "ip", "udp", "sport", "67", "drop"),
    ]:
        call("nft", "add", "rule", "bridge", "rp_lan", chain,
             "iifname", tunnel, *tail)


def nft_remove(chain: str):
    call("nft", "flush", "chain", "bridge", "rp_lan", chain, ignore=True)
    call("nft", "delete", "chain", "bridge", "rp_lan", chain, ignore=True)


def reconcile(config: dict, current: dict):
    gate, tenant = config["gateId"], config["tenantId"]
    uuid.UUID(gate)
    uuid.UUID(tenant)
    old = current.get("attachments", {})
    if current.get("gateId") not in (None, gate) or current.get("tenantId") not in (None, tenant):
        raise ValueError("Persisted LAN state belongs to a different Gate")
    if config.get("lanAttachmentProtocol") != 1:
        raise ValueError("Unsupported LAN attachment protocol")
    required = config.get("lanAttachments", [])
    if not isinstance(required, list) or len(required) > 64:
        raise ValueError("Invalid desired LAN attachments")
    new = {}
    for item in required:
        if not isinstance(item, dict):
            raise ValueError("Invalid LAN attachment")
        a, physical, mac = item["id"], item["lanInterface"], item["macAddress"]
        uuid.UUID(a)
        uuid.UUID(item["singleAppId"])
        uuid.UUID(item["networkId"])
        if not MAC_RE.fullmatch(mac) or int(mac[:2], 16) & 3 != 2:
            raise ValueError("Untrusted application MAC")
        if not DEVICE_RE.fullmatch(physical) or physical in ("rp-gate", "lo", "docker0"):
            raise ValueError("Invalid Gate LAN interface")
        cidr = ipaddress.ip_network(item["lanCidr"], strict=True)
        if cidr.version != 4 or not 16 <= cidr.prefixlen <= 30:
            raise ValueError("Invalid LAN subnet")
        if a in new:
            raise ValueError("Duplicate L2 attachment")
        new[a] = {"lanInterface": physical, "macAddress": mac, "singleAppId": item["singleAppId"],
                  "networkId": item["networkId"], "lanCidr": str(cidr)}
    # Always clean up revoked attachments even when the handshake is stale.
    for a in sorted(set(old) - set(new)):
        remove_one(gate, tenant, a, old[a], new, old)
        old.pop(a, None)
    if new and not is_handshake_recent(config.get("serverPublicKey")):
        raise RuntimeError("Missing fresh authenticated WireGuard peer handshake")
    if not new:
        return {"gateId": gate, "tenantId": tenant, "attachments": old}
    client, server = underlay(config)
    applied = []
    try:
        for a, item in sorted(new.items()):
            if a in old and old[a] == item:
                continue
            if a in old:
                raise ValueError("Changed attachment requires revoke-and-recreate")
            apply_one(gate, tenant, a, item, client, server)
            applied.append(a)
            old[a] = item
    except Exception:
        # A failed batch must never leave newly created L2 ports active
        # without a durable record authorizing their removal on the next run.
        for a in reversed(applied):
            try:
                remove_one(gate, tenant, a, new[a], {}, old)
                old.pop(a, None)
            except Exception as cleanup_error:
                # Persist authorization for a later cleanup attempt before
                # failing. A failed rollback must never lose the only record
                # of a live privileged L2 attachment.
                save_state({"gateId": gate, "tenantId": tenant, "attachments": old})
                print("LAN rollback blocked: %s" % cleanup_error, file=sys.stderr)
                raise RuntimeError("Unsafe partial LAN reconciliation; cleanup required") from cleanup_error
        raise
    return {"gateId": gate, "tenantId": tenant, "attachments": old}


def apply_one(gate: str, tenant: str, aid: str, item: dict, client: str, server: str):
    tunnel, bridge, chain, key = names(gate, tenant, aid, item["lanInterface"])
    links, addresses, routes = device_state()
    already = validate_link(item["lanInterface"], bridge, gate, links, addresses, routes)
    if any(l.get("ifname") == tunnel for l in links):
        raise ValueError("Tunnel interface already exists and is not in persisted state")
    bridge_created = False
    try:
        if not already:
            call("ip", "link", "add", bridge, "type", "bridge",
                 "stp_state", "1", "vlan_filtering", "1", "mcast_snooping", "0")
            bridge_created = True
            call("ip", "link", "set", "dev", bridge, "alias",
                 "rp-lan:" + gate + ":" + item["lanInterface"])
            call("ip", "link", "set", "dev", item["lanInterface"], "master", bridge)
            call("ip", "link", "set", "dev", bridge, "up")
        call("ip", "link", "add", tunnel, "type", "gretap",
             "local", client, "remote", server, "key", key, "dev", WG, "ttl", "64")
        call("ip", "link", "set", "dev", tunnel, "mtu", "1280")
        call("ip", "link", "set", "dev", tunnel, "up")
        nft_install(chain, tunnel, item["macAddress"])
        call("ip", "link", "set", "dev", tunnel, "master", bridge)
        call("bridge", "link", "set", "dev", tunnel, "isolated", "on", "hairpin", "off")
    except Exception:
        # Roll back EVERYTHING created in this attempt, including a newly
        # added physical LAN bridge. Never touch a pre-existing bridge.
        call("ip", "link", "delete", tunnel, ignore=True)
        nft_remove(chain)
        if bridge_created:
            call("ip", "link", "set", "dev", item["lanInterface"], "nomaster", ignore=True)
            call("ip", "link", "delete", bridge, ignore=True)
        raise


def remove_one(gate: str, tenant: str, aid: str, item: dict, new: dict, old: dict):
    tunnel, bridge, chain, _ = names(gate, tenant, aid, item["lanInterface"])
    links, _, _ = device_state()
    owner = next((l for l in links if l.get("ifname") == bridge), None)
    if not owner:
        # Already absent after a crash between kernel cleanup and state sync.
        nft_remove(chain)
        return
    if owner.get("ifalias") != "rp-lan:" + gate + ":" + item["lanInterface"]:
        raise ValueError("Refusing to delete an unowned Gate bridge")
    peer = next((l for l in links if l.get("ifname") == tunnel), None)
    if peer and peer.get("master") != bridge:
        raise ValueError("Refusing to delete a tunnel attached outside its bridge")
    if peer:
        call("ip", "link", "delete", tunnel)
    nft_remove(chain)
    if not any(v["lanInterface"] == item["lanInterface"] for v in new.values()) and \
            not any(v["lanInterface"] == item["lanInterface"] for id_, v in old.items() if id_ != aid):
        ports = {l.get("ifname") for l in links if l.get("master") == bridge}
        if ports - {item["lanInterface"], tunnel}:
            raise ValueError("Unexpected network members; refusing bridge removal")
        call("ip", "link", "set", "dev", item["lanInterface"], "nomaster")
        call("ip", "link", "delete", bridge)


def load_state() -> dict:
    if not STATE.exists():
        return {"attachments": {}}
    obj = json.loads(STATE.read_text())
    if not isinstance(obj, dict) or not isinstance(obj.get("attachments"), dict):
        raise ValueError("Corrupted Gate attachment state")
    return obj


def save_state(state: dict):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = STATE.with_suffix(".tmp")
    with open(temp, "w", encoding="utf8") as fd:
        os.fchmod(fd.fileno(), 0o600)
        json.dump(state, fd, sort_keys=True)
        fd.flush()
        os.fsync(fd.fileno())
    os.replace(temp, STATE)


def main():
    if os.geteuid() != 0:
        raise ValueError("Only root may reconcile RP Gate LAN attachments")
    state = load_state()
    if sys.argv[1:] == ["--revoke-all"]:
        # Authorization failures and agent shutdown must be able to revoke
        # the last approved L2 links WITHOUT any reachable control plane.
        if not state.get("attachments"):
            return
        if not state.get("gateId") or not state.get("tenantId"):
            raise ValueError("Unsafe persisted Gate LAN state: owner unknown")
        config = {"gateId": state["gateId"], "tenantId": state["tenantId"],
                  "lanAttachmentProtocol": 1, "lanAttachments": []}
    elif len(sys.argv) == 1:
        config = json.load(sys.stdin)
    else:
        raise ValueError("Unsupported Gate LAN command")
    next_state = reconcile(config, state)
    save_state(next_state)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("ResourcePortalGate L2 reconcile blocked: %s" % exc, file=sys.stderr)
        sys.exit(1)
