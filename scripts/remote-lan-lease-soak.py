#!/usr/bin/env python3
"""Disposable real WG/GRETAP HA-like UDP event stream for a *silent* control plane.

No RP API is contacted: the caller must install one bounded Gate nft source rule
and MUST NOT renew it during the 443-second experiment. This alone does NOT
certify RP API/Traefik shutdown, but proves continuous bidirectional packets
and expiry on real kernel interfaces instead of merely observing link state.
"""
import argparse
import json
import os
import socket
import time

TARGET = ("192.168.90.1", 46331)
CLIENT_IP = "192.168.90.24"


def receiver():
    ready = os.environ["RP_EVENT_READY"]
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(TARGET)
    sock.settimeout(1)
    with open(ready, "x", encoding="utf-8"):
        pass
    deadline = time.monotonic() + 660
    while time.monotonic() < deadline:
        try:
            data, address = sock.recvfrom(2048)
        except socket.timeout:
            continue
        if data.startswith((b"motion:", b"click:")):
            sock.sendto(b"ACK:" + data, address)


def client(duration):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((CLIENT_IP, 0))
        sock.settimeout(2)
        start = time.monotonic()
        successes = 0
        for i in range(90):
            target = start + (duration if i == 89 else i * duration / 89)
            time.sleep(max(0, target - time.monotonic()))
            data = (("motion:" if i % 2 == 0 else "click:") + str(i)).encode()
            for attempt in range(2):
                sock.sendto(data, TARGET)
                try:
                    received, _ = sock.recvfrom(2048)
                    if received == b"ACK:" + data:
                        successes += 1
                        break
                except socket.timeout:
                    continue
            else:
                raise SystemExit("No HA-like LAN acknowledgment for event %d" % i)
        elapsed = time.monotonic() - start
        if successes != 90 or elapsed < duration:
            raise SystemExit("Insufficient event continuity")
        print(json.dumps({"elapsedSeconds": round(elapsed, 2),
                          "acknowledged": successes, "motion": 45,
                          "click": 45, "bidirectional": True}))

def denied():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((CLIENT_IP, 0))
        sock.settimeout(1.5)
        sock.sendto(b"motion:after-lease-expired", TARGET)
        try:
            received, _ = sock.recvfrom(2048)
        except (socket.timeout, ConnectionRefusedError):
            print("PASS: expired Gate source denied HA-like packet")
            return
        raise SystemExit("FAIL: expired Gate source still forwarded " + repr(received))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["receiver", "client", "denied"])
    parser.add_argument("--duration", type=int, default=443)
    args = parser.parse_args()
    if args.mode == "receiver":
        receiver()
    elif args.mode == "client":
        if not 1 <= args.duration <= 600:
            parser.error("Unexpected smoke duration")
        client(args.duration)
    else:
        denied()
