#!/usr/bin/env python3
"""Functional mock-socket checks for multihomed Site VPN discovery."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[2]
agent_path = root / "packages/resourceportal-api/src/networking/gate-discovery-agent.py"
spec = importlib.util.spec_from_file_location("gate_discovery", agent_path)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

settings = {
    "enabled": True,
    "clientTunnelAddress": "10.253.0.2/32",
    "serverTunnelAddress": "10.253.0.1/32",
    "lanAddresses": ["192.168.60.2", "192.168.50.2"],
    "lanCidrs": ["192.168.50.0/24", "192.168.60.0/24"],
}
with tempfile.NamedTemporaryFile("w", delete=False) as tmp:
    path = tmp.name
    json.dump(settings, tmp)
try:
    relay.CONF = path
    desired = relay.read_config()
    assert desired[2] == ("192.168.50.2", "192.168.60.2")
    assert len(desired[3]) == 2
    opened = []

    class FakeSocket:
        def __init__(self, port, protocol, lan):
            self.port, self.protocol, self.lan = port, protocol, lan
            self.closed = False
            opened.append(self)

        def bind(self, address):
            pass

        def close(self):
            self.closed = True

    relay.socket.socket = lambda *args: FakeSocket(53540, "control", None)
    relay.socket_for_lan = lambda port, group, lan: FakeSocket(port, group, lan)
    relay.read_config = lambda: None  # Exit immediately after socket setup
    relay.serve(desired)
    assert len(opened) == 5, [(x.port, x.lan) for x in opened]
    assert all(x.closed for x in opened)
    for lan in desired[2]:
        assert any(x.lan == lan and x.protocol == "224.0.0.251" for x in opened)
        assert any(x.lan == lan and x.port == 0 for x in opened)

    # Reinstantiate the module to restore its real config loader.
    spec.loader.exec_module(relay)
    relay.CONF = path
    settings["lanAddresses"].append("8.8.8.8")
    with open(path, "w") as out:
        json.dump(settings, out)
    try:
        relay.read_config()
        raise AssertionError("Foreign LAN CIDR accepted")
    except ValueError:
        pass
finally:
    os.unlink(path)
print("PASS: per-interface LAN discovery and foreign-address rejection")
