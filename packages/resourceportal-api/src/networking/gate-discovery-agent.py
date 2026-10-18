#!/usr/bin/env python3
"""Site VPN LAN-side discovery relay. Only RP Gate WireGuard peers can query.

This is a bounded application-discovery bridge, not an L2 tunnel. No arbitrary
unicast forwarding, SSDP NOTIFY traffic or cross-tenant discovery is accepted.
"""
import base64
import ipaddress
import json
import os
import re
import select
import socket
import sys
import time

CONF = "/etc/resourceportal-gate/discovery.json"
PORT = 53540
MAX_PAYLOAD = 1200
SESSION_TTL = 5.0
MAX_RESPONSES_PER_SESSION = 20
MAX_SESSIONS = 256
SESSION_RE = re.compile(r"^[0-9a-f]{24}$")


def log(message):
    print("[ResourcePortalGate Discovery] " + message, file=sys.stderr, flush=True)


def read_config():
    with open(CONF, "r", encoding="utf8") as source:
        config = json.load(source)
    if config.get("enabled") is not True:
        return None
    local = str(ipaddress.IPv4Interface(config["clientTunnelAddress"]).ip)
    remote = str(ipaddress.IPv4Interface(config["serverTunnelAddress"]).ip)
    lan = str(ipaddress.IPv4Address(config["lanAddress"]))
    allowed = [ipaddress.IPv4Network(cidr, strict=False) for cidr in config["lanCidrs"]]
    if not allowed or not any(ipaddress.IPv4Address(lan) in subnet for subnet in allowed):
        raise ValueError("LAN address is outside reported LAN networks")
    return local, remote, lan, allowed


def socket_for_lan(port, group, lan):
    result = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    result.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        result.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    result.bind(("", port))
    result.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(lan))
    result.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    if group:
        result.setsockopt(
            socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
            socket.inet_aton(group) + socket.inet_aton(lan),
        )
    return result


def decode_frame(data, kind):
    if not (12 <= len(data) <= 4000):
        return None
    try:
        frame = json.loads(data.decode("utf8"))
        if (frame.get("version") != 1 or frame.get("kind") != kind or
                not SESSION_RE.fullmatch(frame.get("session", "")) or
                frame.get("protocol") not in ("mdns", "ssdp")):
            return None
        encoded = frame.get("payload")
        if not isinstance(encoded, str) or len(encoded) > 2000:
            return None
        payload = base64.b64decode(encoded, validate=True)
        if not (12 <= len(payload) <= MAX_PAYLOAD):
            return None
        return frame["session"], frame["protocol"], payload
    except (ValueError, TypeError, KeyError):
        return None


def valid_query(protocol, data):
    if protocol == "mdns":
        return len(data) >= 12 and not data[2] & 0x80 and int.from_bytes(data[4:6], "big") > 0
    return (data.startswith(b"M-SEARCH * HTTP/1.1\r\n") and
            b"man:" in data.lower() and b"ssdp:discover" in data.lower() and
            data.endswith(b"\r\n\r\n"))


def valid_reply(protocol, data):
    if protocol == "mdns":
        return len(data) >= 12 and bool(data[2] & 0x80)
    return data.startswith(b"HTTP/1.1 200")


def serve(config):
    local, remote, lan, cidrs = config
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    control.bind((local, PORT))
    mdns = socket_for_lan(5353, "224.0.0.251", lan)
    ssdp = socket_for_lan(0, None, lan)
    sessions = {}
    print("[ResourcePortalGate Discovery] relay active", flush=True)
    sockets = {control: None, mdns: "mdns", ssdp: "ssdp"}
    try:
        while True:
            try:
                if read_config() != config:
                    return
            except (ValueError, OSError, KeyError):
                return
            for key, entry in list(sessions.items()):
                if entry["expires"] < time.monotonic():
                    del sessions[key]
            ready, _, _ = select.select(list(sockets), [], [], 1.0)
            for receiver in ready:
                data, sender = receiver.recvfrom(4096)
                if receiver is control:
                    if sender[0] != remote:
                        continue
                    parsed = decode_frame(data, "query")
                    if not parsed or len(sessions) >= MAX_SESSIONS:
                        continue
                    session, protocol, payload = parsed
                    if not valid_query(protocol, payload):
                        continue
                    sessions[session] = {
                        "protocol": protocol,
                        "expires": time.monotonic() + SESSION_TTL,
                        "responses": 0,
                    }
                    target = ("224.0.0.251", 5353) if protocol == "mdns" else ("239.255.255.250", 1900)
                    (mdns if protocol == "mdns" else ssdp).sendto(payload, target)
                else:
                    proto = sockets[receiver]
                    try:
                        sender_ip = ipaddress.IPv4Address(sender[0])
                    except ValueError:
                        continue
                    if not any(sender_ip in cidr for cidr in cidrs):
                        continue
                    if len(data) > MAX_PAYLOAD or not valid_reply(proto, data):
                        continue
                    for session, item in sessions.items():
                        if item["protocol"] != proto or item["responses"] >= MAX_RESPONSES_PER_SESSION:
                            continue
                        item["responses"] += 1
                        frame = json.dumps({
                            "version": 1, "kind": "response", "session": session,
                            "protocol": proto, "payload": base64.b64encode(data).decode("ascii"),
                        }, separators=(",", ":")).encode("utf8")
                        control.sendto(frame, (remote, PORT))
    finally:
        for item in sockets:
            item.close()


def main():
    while True:
        try:
            desired = read_config()
            if desired:
                serve(desired)
            else:
                time.sleep(2)
        except (ValueError, OSError, KeyError) as error:
            log(str(error))
            time.sleep(5)


if __name__ == "__main__":
    main()
