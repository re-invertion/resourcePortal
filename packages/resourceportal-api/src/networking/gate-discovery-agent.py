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
    raw_lans = config.get("lanAddresses", [])
    raw_cidrs = config.get("lanCidrs", [])
    if not isinstance(raw_lans, list) or not isinstance(raw_cidrs, list):
        raise ValueError("Discovery LAN configuration must contain arrays")
    if not (1 <= len(raw_lans) <= 16 and 1 <= len(raw_cidrs) <= 32):
        raise ValueError("Discovery requires a bounded list of LAN interfaces")
    lans = tuple(sorted({str(ipaddress.IPv4Address(ip)) for ip in raw_lans}))
    cidrs = tuple(sorted({
        ipaddress.IPv4Network(cidr, strict=False) for cidr in raw_cidrs
    }))
    for lan in lans:
        if not any(ipaddress.IPv4Address(lan) in cidr for cidr in cidrs):
            raise ValueError("Discovery LAN address is outside reported LAN networks")
    return local, remote, lans, cidrs


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
    local, remote, lans, cidrs = config
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sockets = {}
    try:
        control.bind((local, PORT))
        sockets[control] = (None, None)
        # Socket membership and multicast interface are selected independently
        # for every authorized physical LAN, never only the first interface.
        for lan in lans:
            sockets[socket_for_lan(5353, "224.0.0.251", lan)] = ("mdns", lan)
            sockets[socket_for_lan(0, None, lan)] = ("ssdp", lan)
        sessions = {}
        print("[ResourcePortalGate Discovery] relay active on " +
              str(len(lans)) + " physical LANs", flush=True)
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
                    for outbound, (outbound_proto, _) in sockets.items():
                        if outbound_proto == protocol:
                            outbound.sendto(payload, target)
                else:
                    proto, lan = sockets[receiver]
                    try:
                        sender_ip = ipaddress.IPv4Address(sender[0])
                    except ValueError:
                        continue
                    # A reply must belong to the same physical LAN as its
                    # receiving socket, not merely any other attached LAN.
                    lan_ip = ipaddress.IPv4Address(lan)
                    if not any(sender_ip in cidr and lan_ip in cidr for cidr in cidrs):
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
        if control not in sockets:
            control.close()


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
