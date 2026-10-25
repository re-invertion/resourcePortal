#!/usr/bin/env python3
"""One physical Ethernet, no Wi-Fi dependency; mocked native NetworkManager."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase, main, mock

source = Path(__file__).resolve().parent.parent / "packages/resourceportal-api/src/networking/gate-managed-uplink.py"
spec = importlib.util.spec_from_file_location("rp_native_nm", source)
uplink = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uplink)
GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
ORIGINAL = "11111111-1111-4111-8111-111111111111"


class NativeNetworkManagerTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for k in ("STATE", "SYSTEMD", "NETWORKD", "NETPLAN", "SYSFS"):
            path = root / k.lower()
            path.mkdir()
            patch = mock.patch.object(uplink, k, path)
            patch.start()
            self.addCleanup(patch.stop)
        self.plan = {
            "protocol": 1, "gateId": GATE, "device": "eth0",
            "bridge": uplink.bridge_name(GATE, "eth0"),
            "networkCidr": "192.168.100.0/24", "gateway": "192.168.100.1",
            "manager": "NativeNetworkManager", "bridgeMac": "88:a2:9e:01:d5:e3",
            "routeMetric": 100, "originalUuid": ORIGINAL,
            "originalName": "netplan-eth0", "portPriority": 50,
            "bridgeUuid": uplink.native_nm_uuid(GATE, "eth0", "bridge"),
            "portUuid": uplink.native_nm_uuid(GATE, "eth0", "port"),
            "checkedAt": 1000, "state": "Preflight",
        }
        self.br = self.plan["bridge"]
        self.original = ORIGINAL

    def test_native_profile_identifiers_are_deterministic_and_isolated(self):
        self.assertEqual(self.plan["bridgeUuid"], uplink.native_nm_uuid(GATE, "eth0", "bridge"))
        self.assertNotEqual(self.plan["bridgeUuid"], self.plan["portUuid"])
        self.assertNotEqual(self.plan["bridgeUuid"], ORIGINAL)
        self.assertFalse(self.br.startswith("netplan-"))
        self.assertFalse(uplink.native_nm_port(self.plan).startswith("netplan-"))
        uplink.native_nm_identity(self.plan)
        corrupt = dict(self.plan, portUuid=ORIGINAL)
        with self.assertRaisesRegex(ValueError, "Unsafe NetworkManager"):
            uplink.native_nm_identity(corrupt)

    def test_migration_preserves_original_netplan_and_wifi(self):
        actions = []
        def exists(uid):
            return uid == ORIGINAL
        def called(*args):
            actions.append(args)
            return "ok"
        with mock.patch.object(uplink, "nm_connection_exists", side_effect=exists), \
             mock.patch.object(uplink, "nm_connection_matches", return_value=True), \
             mock.patch.object(uplink, "call", side_effect=called):
            uplink.apply_native_networkmanager(self.plan)
        self.assertEqual(len([c for c in actions if c[:3] == ("nmcli","connection","add")]), 2)
        self.assertTrue(any("bridge.mac-address" in c and self.plan["bridgeMac"] in c for c in actions))
        self.assertTrue(any("connection.autoconnect-priority" in c and "50" in c for c in actions))
        self.assertTrue(any(c[:5] == ("nmcli","--wait","35","connection","up") for c in actions))
        self.assertFalse(any(c and c[0] == "netplan" for c in actions))
        self.assertFalse(any(c[:3] == ("nmcli","connection","modify") for c in actions))
        self.assertFalse(any("wlan0" in c for c in actions))

    def test_arm_schedules_independent_watchdog_confirm_and_migration(self):
        actions = []
        def called(*args):
            actions.append(args)
            if args == ("systemctl","is-active",uplink.WATCH+".timer"):
                return "active"
            return ""
        with mock.patch.object(uplink, "call", side_effect=called):
            uplink.arm(self.plan)
        self.assertTrue(uplink.checkpoint_file().exists())
        self.assertIn("OnBootSec=120s", (uplink.SYSTEMD / (uplink.WATCH+".timer")).read_text())
        self.assertIn("auto-confirm", (uplink.SYSTEMD / "resourceportal-gate-uplink-autoconfirm.service").read_text())
        self.assertIn("ExecStart=", (uplink.SYSTEMD / "resourceportal-gate-uplink-migrate.service").read_text())
        enable = ("systemctl","enable","--now",uplink.WATCH+".timer")
        confirm = ("systemctl","start","--no-block","resourceportal-gate-uplink-autoconfirm.service")
        migrate = ("systemctl","start","--no-block","resourceportal-gate-uplink-migrate.service")
        self.assertLess(actions.index(enable),actions.index(confirm))
        self.assertLess(actions.index(confirm),actions.index(migrate))
        self.assertFalse(any(x[0] == "netplan" for x in actions))
        self.assertFalse(any(x[0] == "nmcli" for x in actions))

    def test_rollback_recovers_original_before_removing_owned_profiles(self):
        uplink.STATE.mkdir(exist_ok=True)
        uplink.checkpoint_file().write_text(json.dumps(self.plan))
        uplink_links = [{"ifname":"eth0","link_type":"ether","operstate":"UP"}]
        addrs = [{"ifname":"eth0","addr_info":[
            {"family":"inet","scope":"global","local":"192.168.100.142","prefixlen":24}]}]
        routes = [{"dst":"default","dev":"eth0","gateway":"192.168.100.1","metric":100}]
        actions = []
        def called(*args):
            actions.append(args)
            if args[:5] == ("ip","-j","-d","link","show"):
                return "[]"
            return ""
        with mock.patch.object(uplink,"service_active",side_effect=lambda svc:svc=="NetworkManager"), \
             mock.patch.object(uplink,"nm_connection_exists",return_value=True), \
             mock.patch.object(uplink,"nm_connection_matches",return_value=True), \
             mock.patch.object(uplink,"call",side_effect=called), \
             mock.patch.object(uplink.subprocess,"run",return_value=SimpleNamespace(returncode=0)), \
             mock.patch.object(uplink,"snapshot",return_value=(uplink_links,addrs,routes)):
            uplink.rollback()
        self.assertFalse(uplink.checkpoint_file().exists())
        down_port = ("nmcli","--wait","10","connection","down","uuid",self.plan["portUuid"])
        up_original = ("nmcli","--wait","35","connection","up","uuid",ORIGINAL,"ifname","eth0")
        delete_port = ("nmcli","connection","delete","uuid",self.plan["portUuid"])
        self.assertIn(up_original, actions)
        self.assertLess(actions.index(up_original),actions.index(delete_port))
        self.assertFalse(any(c[:3] == ("nmcli","connection","modify") for c in actions))

    def test_rollback_retains_checkpoint_if_foreign_member_on_bridge(self):
        uplink.STATE.mkdir(exist_ok=True)
        uplink.checkpoint_file().write_text(json.dumps(self.plan))
        links = [
            {"ifname":self.br,"linkinfo":{"info_kind":"bridge"}},
            {"ifname":"eth1","master":self.br}
        ]
        def called(*args):
            if args[:5] == ("ip","-j","-d","link","show"):
                return json.dumps(links)
            return ""
        with mock.patch.object(uplink,"service_active",side_effect=lambda svc:svc=="NetworkManager"), \
             mock.patch.object(uplink,"nm_connection_exists",return_value=True), \
             mock.patch.object(uplink,"nm_connection_matches",return_value=True), \
             mock.patch.object(uplink,"call",side_effect=called):
            with self.assertRaisesRegex(ValueError,"foreign LAN bridge"):
                uplink.rollback()
        self.assertTrue(uplink.checkpoint_file().exists())

    def test_auto_confirm_retries_real_checks_and_fails_closed(self):
        uplink.STATE.mkdir(exist_ok=True)
        uplink.checkpoint_file().write_text(json.dumps(self.plan))
        with mock.patch.object(uplink, "confirm",side_effect=[RuntimeError("DHCP pending"),True]) as confirm, \
             mock.patch.object(uplink.time, "sleep") as sleep:
            uplink.auto_confirm()
            self.assertEqual(confirm.call_count,2)
            sleep.assert_called_once_with(2)

    def test_physical_discovery_excludes_wifi_virtual_and_bridge(self):
        for device in ("eth0","wlan0","enp2s0"):
            root = uplink.SYSFS / device
            root.mkdir()
            (root/"device").mkdir()
        (uplink.SYSFS/"wlan0"/"wireless").mkdir()
        links = [
            {"ifname":"eth0","link_type":"ether","operstate":"UP"},
            {"ifname":"wlan0","link_type":"ether","operstate":"UP"},
            {"ifname":"enp2s0","link_type":"ether","operstate":"UP"},
            {"ifname":"rp-gb-abc12345","link_type":"ether","operstate":"UP",
             "linkinfo":{"info_kind":"bridge"}},
            {"ifname":"veth1","link_type":"ether","operstate":"UP"},
            {"ifname":"docker0","link_type":"ether","operstate":"UP"},
        ]
        with mock.patch.object(uplink,"call",return_value=json.dumps(links)):
            self.assertEqual(uplink.ethernet_candidates(),["enp2s0","eth0"])


if __name__ == "__main__":
    main()
