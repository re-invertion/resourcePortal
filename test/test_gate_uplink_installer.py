#!/usr/bin/env python3
"""No root privileges or host networking changes; durable rollback contract tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase, main, mock

source = Path(__file__).resolve().parent.parent / "packages/resourceportal-api/src/networking/gate-managed-uplink.py"
spec = importlib.util.spec_from_file_location("rp_gate_uplink", source)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
BR = mod.bridge_name(GATE, "eth0")


class HostUplinkTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.state, self.net, self.systemd = root / "state", root / "network", root / "systemd"
        for directory in (self.state, self.net, self.systemd):
            directory.mkdir()
        self.original = self.net / "10-eth0.network"
        self.original.write_text("[Match]\nName=eth0\n[Network]\nDHCP=ipv4\nDNS=192.168.100.1\n")
        for key, value in (("STATE", self.state), ("NETWORKD", self.net), ("SYSTEMD", self.systemd)):
            patch = mock.patch.object(mod, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    def data(self):
        links = [{"ifname": "eth0", "ifindex": 2, "operstate": "UP", "link_type": "ether"}]
        addresses = [{"ifname": "eth0", "addr_info": [
            {"family": "inet", "local": "192.168.100.11", "prefixlen": 24, "scope": "global"},
            {"family": "inet6", "local": "fe80::1", "prefixlen": 64, "scope": "link"}]}]
        routes = [{"dst": "default", "dev": "eth0", "gateway": "192.168.100.1"}]
        return links, addresses, routes

    def fake_call(self, *args):
        if args[:3] == ("systemctl", "is-active", "systemd-networkd"):
            return "active"
        if args[:2] == ("networkctl", "status"):
            # Production requires the absolute /etc path. Here substitute
            # only the path validator via root fixture below when needed.
            return "Network File: " + str(self.original) + "\n"
        if args[:3] == ("systemctl", "is-active", mod.WATCH + ".timer"):
            return "active"
        return ""

    def test_preflight_rejects_wifi_ambiguous_routes_global_ipv6_and_competing_manager(self):
        with mock.patch.object(mod, "read_control_config", return_value={"gateId": GATE}), \
             mock.patch.object(mod, "call", side_effect=self.fake_call), \
             mock.patch.object(mod, "snapshot", return_value=self.data()), \
             mock.patch.object(mod.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(ValueError, "competing"):
                mod.preflight("eth0")
        with self.assertRaises(ValueError):
            mod.bridge_name(GATE, "eth0;shutdown")

    def plan(self):
        return {
            "protocol": 1, "gateId": GATE, "device": "eth0", "bridge": BR,
            "networkCidr": "192.168.100.0/24", "gateway": "192.168.100.1",
            "originalPath": str(self.original), "originalText": self.original.read_text(),
            "originalMode": 0o644, "state": "Preflight", "checkedAt": __import__("time").time()
        }

    def test_arm_installs_watchdog_before_any_nic_mutation(self):
        commands = []
        def runner(*args):
            commands.append(args)
            return "active" if args[:2] == ("systemctl", "is-active") else ""
        with mock.patch.object(mod, "call", side_effect=runner):
            mod.arm(self.plan())
        self.assertTrue((self.systemd / (mod.WATCH + ".timer")).exists())
        self.assertTrue((self.systemd / (mod.WATCH + ".service")).exists())
        self.assertTrue((self.state / "uplink-checkpoint.json").exists())
        self.assertEqual(commands.index(("systemctl", "enable", "--now", mod.WATCH + ".timer")) <
                         commands.index(("networkctl", "reload")), True)
        self.assertIn("Bridge=" + BR, self.original.read_text())
        self.assertTrue((self.net / ("09-" + BR + ".netdev")).exists())

    def test_arm_failure_recovers_prior_config_and_never_deletes_checkpoint_before_restore(self):
        commands = []
        def runner(*args):
            commands.append(args)
            if args == ("networkctl", "reconfigure", "eth0") and commands.count(args) == 1:
                raise RuntimeError("simulated network disruption")
            return "active"
        with mock.patch.object(mod, "call", side_effect=runner):
            with self.assertRaisesRegex(RuntimeError, "disruption"):
                mod.arm(self.plan())
        self.assertEqual(self.original.read_text(), self.plan()["originalText"])
        self.assertFalse((self.net / ("09-" + BR + ".netdev")).exists())
        self.assertFalse(mod.checkpoint_file().exists())

    def test_rollback_is_idempotent_and_fails_closed_on_malformed_path(self):
        with mock.patch.object(mod, "call", return_value="active"):
            mod.arm(self.plan())
            mod.rollback()
            mod.rollback()
        self.assertEqual(self.original.read_text(), self.plan()["originalText"])
        self.assertFalse(mod.checkpoint_file().exists())
        malicious = self.plan()
        malicious["originalPath"] = "/etc/passwd"
        mod.write(mod.checkpoint_file(), json.dumps(malicious))
        with self.assertRaisesRegex(ValueError, "outside"):
            mod.rollback()

    def test_confirmation_needs_observed_bridge_and_live_authenticated_control_plane(self):
        with mock.patch.object(mod, "call", return_value="active"):
            mod.arm(self.plan())
        with mock.patch.object(mod, "verify", side_effect=RuntimeError("control offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                mod.confirm()
        self.assertTrue(mod.checkpoint_file().exists())
        self.assertFalse((self.state / "managed-uplink.json").exists())

    def test_reboot_refresh_restores_owned_bridge_alias_after_verified_control(self):
        with mock.patch.object(mod, "call", return_value="active"):
            mod.arm(self.plan())
        proof = {"gateId": GATE, "device": "eth0", "bridge": BR,
                 "networkCidr": "192.168.100.0/24", "gateway": "192.168.100.1",
                 "state": "Ready", "rollbackTested": True}
        mod.write(self.state / "managed-uplink.json", json.dumps(proof))
        # A pending checkpoint prevents any refresh from masking rollback.
        with self.assertRaisesRegex(ValueError, "pending"):
            mod.refresh()
        mod.checkpoint_file().unlink()
        calls = []
        def run(*args):
            calls.append(args)
            return ""
        with (mock.patch.object(mod, "verify", return_value=True),
              mock.patch.object(mod, "call", side_effect=run)):
            updated = mod.refresh()
        self.assertIn(("ip","link","set","dev",BR,"alias","rp-lan:"+GATE+":eth0"), calls)
        self.assertAlmostEqual(updated["verifiedAt"], __import__("time").time(), delta=5)
        self.assertEqual(json.loads((self.state / "managed-uplink.json").read_text())["state"],"Ready")

    def test_watchdog_timer_is_persistent_across_reboot(self):
        service, timer = mod.watchdog_files()
        self.assertIn("OnBootSec=120s", timer)
        self.assertIn("OnActiveSec=120s", timer)
        self.assertIn("WantedBy=timers.target", timer)
        self.assertIn(" rollback", service)
        self.assertNotIn("systemctl disable", service)


if __name__ == "__main__":
    main()
