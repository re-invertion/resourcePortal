#!/usr/bin/env python3
"""Fail-closed Raspberry Pi Netplan/NetworkManager bridge migration tests.

Only temporary directories and mocked commands. Never mutates host networking.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest import TestCase, main, mock

source = Path(__file__).resolve().parent.parent / "packages/resourceportal-api/src/networking/gate-managed-uplink.py"
spec = importlib.util.spec_from_file_location("rp_gate_netplan", source)
uplink = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uplink)

GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
BR = uplink.bridge_name(GATE, "eth0")


class NetworkManagerGateTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for key, subdir in (("NETPLAN","netplan"),("STATE","state"),
                            ("SYSTEMD","systemd"),("NETWORKD","networkd")):
            path = root / subdir
            path.mkdir()
            patch = mock.patch.object(uplink, key, path)
            patch.start()
            self.addCleanup(patch.stop)
        self.wifi_file = uplink.NETPLAN / "50-wlan.yaml"
        self.wifi_file.write_text("network:\n  version: 2\n  wifis:\n    wlan0:\n      dhcp4: true\n")
        self.active = lambda svc: svc == "NetworkManager"
        self.netplan = {"network":{"version":2,"renderer":"NetworkManager",
           "ethernets":{"eth0":{"dhcp4": True,"dhcp6":False}},
           "wifis":{"wlan0":{"dhcp4":True}}}}

    def snapshot(self):
        links = [{"ifname":"eth0","link_type":"ether","address":"dc:a6:32:10:20:30",
                  "operstate":"UP"},
                 {"ifname":"wlan0","link_type":"ether","operstate":"UP"}]
        addrs = [{"ifname":"eth0","addr_info":[
            {"family":"inet","local":"192.168.100.142","prefixlen":24,"scope":"global"},
            {"family":"inet6","local":"fe80::1","prefixlen":64,"scope":"link"}]},
            {"ifname":"wlan0","addr_info":[
            {"family":"inet","local":"192.168.100.143","prefixlen":24,"scope":"global"}]}]
        routes = [{"dst":"default","dev":"eth0","gateway":"192.168.100.1","metric":100},
                  {"dst":"default","dev":"wlan0","gateway":"192.168.100.1","metric":600}]
        return links, addrs, routes

    def commands(self,*args):
        if args == ("nmcli","-g","GENERAL.CONNECTION","device","show","eth0"):
            return "netplan-eth0"
        if args == ("netplan","get"):return "mocked config"
        if args == ("nmcli","-g","GENERAL.CON-UUID","device","show","eth0"):
            return "75a1216a-9d1a-30cd-8aca-ace5526ec021"
        if args == ("systemctl","is-active",uplink.WATCH+".timer"):return "active"
        if args == ("ip","-j","-d","link","show"):return "[]"
        return ""

    def preflight(self):
        with mock.patch.object(uplink,"read_control_config",return_value={"gateId":GATE}), \
             mock.patch.object(uplink,"service_active",side_effect=self.active), \
             mock.patch.object(uplink,"snapshot",side_effect=self.snapshot), \
             mock.patch.object(uplink,"call",side_effect=self.commands), \
             mock.patch.dict(sys.modules,{"yaml":SimpleNamespace(safe_load=lambda _:self.netplan)}):
            return uplink.preflight("eth0")

    def test_preflight_recognizes_pi_nm_and_backup_wifi_without_mutating_network(self):
        config=self.preflight()
        self.assertEqual(config["manager"],"NetplanNetworkManager")
        self.assertEqual(config["networkCidr"],"192.168.100.0/24")
        self.assertEqual(config["gateway"],"192.168.100.1")
        self.assertEqual(config["routeMetric"],100)
        self.assertEqual(config["bridgeMac"],"dc:a6:32:10:20:30")
        self.assertEqual(self.wifi_file.read_text().count("dhcp4: true"),1)
        self.assertFalse(uplink.netplan_config_file(config).exists())

    def test_debian13_rpi_real_netplan_profile_is_accepted_read_only(self):
        # Matches the sanitized observed netplan-eth0 profile on Pi Debian 13:
        # link-local IPv6 only, DHCPv6 flag enabled, NetworkManager metadata.
        self.netplan["network"]["ethernets"]["eth0"] = {
            "renderer":"NetworkManager", "match":{}, "dhcp4":True,
            "dhcp6":True,
            "networkmanager":{
                "uuid":"75a1216a-9d1a-30cd-8aca-ace5526ec021",
                "name":"netplan-eth0",
                "passthrough":{"proxy._":""}
            }
        }
        with mock.patch.object(uplink.os,"uname",
                               return_value=SimpleNamespace(release="6.18.50+rpt-rpi-v8")):
            plan=self.preflight()
        self.assertEqual(plan["manager"],"NetplanNetworkManager")
        self.assertEqual(plan["networkCidr"],"192.168.100.0/24")
        self.assertEqual(plan["routeMetric"],100)
        self.assertTrue(plan["requiresOutOfBandRecovery"])
        self.assertFalse(plan["applySupported"])  # Pi OS NM rewrite risk
        self.assertFalse(uplink.netplan_config_file(plan).exists())
        self.assertTrue(self.wifi_file.exists())

    def test_trixie_nm_metadata_fails_closed_on_unknown_passthrough_and_uuid(self):
        eth=self.netplan["network"]["ethernets"]["eth0"]
        eth.update(dhcp6=True, match={},
                   networkmanager={"uuid":"75a1216a-9d1a-30cd-8aca-ace5526ec021",
                                   "name":"netplan-eth0","passthrough":{"proxy._":""}})
        self.assertEqual(self.preflight()["manager"],"NetplanNetworkManager")
        eth["networkmanager"]["passthrough"]["connection.autoconnect"]="false"
        with self.assertRaisesRegex(ValueError,"metadata"):
            self.preflight()
        del eth["networkmanager"]["passthrough"]["connection.autoconnect"]
        eth["networkmanager"]["uuid"]="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
        with self.assertRaisesRegex(ValueError,"UUID does not match"):
            self.preflight()
        eth["networkmanager"]["uuid"]="75a1216a-9d1a-30cd-8aca-ace5526ec021"
        eth["match"]={"name":"*"}
        with self.assertRaisesRegex(ValueError,"Customized"):
            self.preflight()

    def test_dhcp6_flag_does_not_mask_live_ipv6_routes_or_global_address(self):
        self.netplan["network"]["ethernets"]["eth0"]["dhcp6"]=True
        original=self.snapshot
        def with_global_v6():
            links,addresses,routes=original()
            addresses[0]["addr_info"].append(
                {"family":"inet6","local":"2001:db8::4","prefixlen":64,"scope":"global"})
            return links,addresses,routes
        with mock.patch.object(self,"snapshot",side_effect=with_global_v6):
            with self.assertRaisesRegex(ValueError,"no global IPv6"):
                self.preflight()
        def active_ipv6_route(*args):
            if args==("ip","-6","-j","route","show","default"):
                return '[{"dst":"default","gateway":"fe80::1","dev":"eth0"}]'
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=active_ipv6_route), \
             mock.patch.object(uplink,"read_control_config",
                               return_value={"gateId":GATE}), \
             mock.patch.object(uplink,"service_active",side_effect=self.active), \
             mock.patch.object(uplink,"snapshot",side_effect=self.snapshot), \
             mock.patch.dict(sys.modules,{"yaml":SimpleNamespace(
                 safe_load=lambda _:self.netplan)}):
            with self.assertRaisesRegex(ValueError,"IPv6 default route"):
                uplink.preflight("eth0")

    def test_pi_os_netplan_apply_never_modifies_host_even_with_opt_in(self):
        import contextlib
        import io
        plan=self.preflight()
        plan["applySupported"]=False
        for opts in ([],["--confirm-local-recovery"]):
            with mock.patch.object(uplink.os,"geteuid",return_value=0), \
                 mock.patch.object(sys,"argv",
                   ["gate-uplink","apply","--device","eth0",*opts]), \
                 mock.patch.object(uplink,"preflight",return_value=plan), \
                 mock.patch.object(uplink,"arm") as arm, \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError,"rollback is not proven safe"):
                    uplink.main()
                arm.assert_not_called()

    def test_other_networkmanager_requires_explicit_local_recovery_for_apply(self):
        plan=self.preflight()
        self.assertTrue(plan["applySupported"])
        import contextlib
        import io
        with mock.patch.object(uplink.os,"geteuid",return_value=0), \
             mock.patch.object(sys,"argv",
                 ["gate-uplink","apply","--device","eth0"]), \
             mock.patch.object(uplink,"preflight",return_value=plan), \
             mock.patch.object(uplink,"arm") as arm, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,"physical/out-of-band"):
                uplink.main()
            arm.assert_not_called()

    def test_rejects_equal_or_preferred_wifi_default_route(self):
        for metric in (0, 100):
            def routes():
                a,b,c=self.snapshot()
                c[1]["metric"]=metric
                return a,b,c
            with mock.patch.object(uplink,"snapshot",side_effect=routes):
                with self.assertRaisesRegex(ValueError,"competing"):
                    uplink.chosen_default(routes()[2],"eth0")

    def test_rejects_non_netplan_profiles_and_custom_ethernet(self):
        with mock.patch.object(uplink,"read_control_config",return_value={"gateId":GATE}), \
             mock.patch.object(uplink,"service_active",side_effect=self.active), \
             mock.patch.object(uplink,"snapshot",side_effect=self.snapshot), \
             mock.patch.dict(sys.modules,{"yaml":SimpleNamespace(safe_load=lambda _:self.netplan)}), \
             mock.patch.object(uplink,"call",return_value="foreign-office-ethernet"):
            with self.assertRaisesRegex(ValueError,"Netplan Ethernet profile"):
                uplink.preflight("eth0")
        self.netplan["network"]["ethernets"]["eth0"]["addresses"]=["192.168.100.142/24"]
        with self.assertRaisesRegex(ValueError,"Customized"):
            self.preflight()
        del self.netplan["network"]["ethernets"]["eth0"]["addresses"]
        self.netplan["network"]["renderer"]="networkd"
        with self.assertRaisesRegex(ValueError,"global renderer"):
            self.preflight()

    def test_watchdog_armed_before_netplan_generate_apply_and_wifi_preserved(self):
        plan=self.preflight()
        calls=[]
        def run(*args):
            calls.append(args)
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=run):
            uplink.arm(plan)
        enable=("systemctl","enable","--now",uplink.WATCH+".timer")
        self.assertLess(calls.index(enable),calls.index(("netplan","generate")))
        self.assertLess(calls.index(enable),calls.index(("netplan","apply")))
        self.assertTrue(uplink.checkpoint_file().exists())
        override=uplink.netplan_config_file(plan)
        self.assertTrue(override.exists())
        self.assertIn("interfaces: [eth0]",override.read_text())
        self.assertIn("route-metric: 100",override.read_text())
        self.assertIn("macaddress: dc:a6:32:10:20:30",override.read_text())
        self.assertTrue(self.wifi_file.exists())
        self.assertEqual(self.wifi_file.read_text().count("dhcp4: true"),1)

    def test_rollback_restores_original_netplan_and_preserves_wifi(self):
        plan=self.preflight()
        with mock.patch.object(uplink,"call",side_effect=self.commands):
            uplink.arm(plan)
        calls=[]
        def run(*args):
            calls.append(args)
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=run), \
             mock.patch.object(uplink,"service_active",side_effect=self.active), \
             mock.patch.object(uplink,"snapshot",side_effect=self.snapshot):
            uplink.rollback()
        self.assertFalse(uplink.netplan_config_file(plan).exists())
        self.assertFalse(uplink.checkpoint_file().exists())
        self.assertTrue(self.wifi_file.is_file())
        self.assertIn(("netplan","apply"),calls)
        self.assertIn(("systemctl","disable","--now",uplink.WATCH+".timer"),calls)

    def test_rollback_does_not_destroy_foreign_netplan_file(self):
        plan=self.preflight()
        with mock.patch.object(uplink,"call",side_effect=self.commands):
            uplink.arm(plan)
        uplink.netplan_config_file(plan).write_text("network:\n  foreign: true\n")
        with mock.patch.object(uplink,"service_active",side_effect=self.active):
            with self.assertRaisesRegex(ValueError,"foreign"):
                uplink.rollback()
        self.assertTrue(uplink.checkpoint_file().exists())
        self.assertTrue(uplink.netplan_config_file(plan).exists())

    def test_orphan_owned_bridge_does_not_block_networkmanager_rollback(self):
        plan=self.preflight()
        with mock.patch.object(uplink,"call",side_effect=self.commands):
            uplink.arm(plan)
        def run(*args):
            if args==("ip","-j","-d","link","show"):
                return json.dumps([{"ifname":"eth0"},
                  {"ifname":BR,"linkinfo":{"info_kind":"bridge"}}])
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=run), \
             mock.patch.object(uplink,"service_active",side_effect=self.active), \
             mock.patch.object(uplink,"snapshot",side_effect=self.snapshot):
            uplink.rollback()
        self.assertFalse(uplink.checkpoint_file().exists())

    def test_refuses_bridge_owned_by_another_physical_port(self):
        plan=self.preflight()
        with mock.patch.object(uplink,"call",side_effect=self.commands):
            uplink.arm(plan)
        def run(*args):
            if args==("ip","-j","-d","link","show"):
                return json.dumps([{"ifname":"eth0"},
                  {"ifname":"eth1","master":BR},
                  {"ifname":BR,"linkinfo":{"info_kind":"bridge"}}])
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=run), \
             mock.patch.object(uplink,"service_active",side_effect=self.active):
            with self.assertRaisesRegex(ValueError,"unverified"):
                uplink.rollback()
        self.assertTrue(uplink.checkpoint_file().exists())
        self.assertTrue(uplink.netplan_config_file(plan).is_file())

    def test_failed_netplan_apply_keeps_restorable_checkpoint(self):
        plan=self.preflight()
        count=0
        def run(*args):
            nonlocal count
            if args==("netplan","apply"):
                count+=1
                raise RuntimeError("NetworkManager lost DHCP")
            return self.commands(*args)
        with mock.patch.object(uplink,"call",side_effect=run), \
             mock.patch.object(uplink,"service_active",side_effect=self.active):
            with self.assertRaisesRegex(RuntimeError,"NetworkManager lost DHCP"):
                uplink.arm(plan)
        self.assertTrue(uplink.checkpoint_file().is_file())
        self.assertTrue(self.wifi_file.is_file())
        self.assertEqual(count,2)  # initial apply and immediate rollback attempt

    def test_verify_bridge_allows_lower_priority_wifi_route_only(self):
        plan=self.preflight()
        with mock.patch.object(uplink,"call",side_effect=self.commands):
            uplink.arm(plan)
        links,addrs,routes=self.snapshot()
        links[0]["master"]=BR
        links.append({"ifname":BR,"link_type":"ether","linkinfo":{"info_kind":"bridge"}})
        addrs[0]["addr_info"]=[]
        addrs.append({"ifname":BR,"addr_info":[
            {"family":"inet","local":"192.168.100.142","prefixlen":24,"scope":"global"}]})
        routes[0]["dev"]=BR
        with mock.patch.object(uplink,"snapshot",return_value=(links,addrs,routes)), \
             mock.patch.object(uplink,"read_control_config",
                               return_value={"gateId":GATE,"apiUrl":"https://rp.example",
                                             "agentToken":"test-token"}), \
             mock.patch.object(uplink.urllib.request,"urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.status=200
            urlopen.return_value.__enter__.return_value.__iter__=None
            with mock.patch.object(uplink.json,"load",return_value={"gateId":GATE}):
                self.assertTrue(uplink.verify(plan))
        routes[1]["metric"]=50
        with mock.patch.object(uplink,"snapshot",return_value=(links,addrs,routes)):
            with self.assertRaisesRegex(RuntimeError,"routing"):
                uplink.verify(plan)

    def test_confirm_and_periodic_refresh_preserve_netplan_verification_plan(self):
        plan = self.preflight()
        with mock.patch.object(uplink, "call", side_effect=self.commands):
            uplink.arm(plan)
        verified_plans = []
        with mock.patch.object(uplink, "verify", side_effect=lambda p: verified_plans.append(dict(p)) or True), \
             mock.patch.object(uplink, "call", side_effect=self.commands):
            confirmed = uplink.confirm()
            refreshed = uplink.refresh()
        self.assertEqual(confirmed["manager"], "NetplanNetworkManager")
        self.assertEqual(confirmed["bridgeMac"], plan["bridgeMac"])
        self.assertEqual(confirmed["routeMetric"], plan["routeMetric"])
        self.assertEqual(refreshed["manager"], "NetplanNetworkManager")
        self.assertEqual(verified_plans, [plan, {k: plan[k] for k in (
            "gateId", "device", "bridge", "networkCidr", "gateway",
            "manager", "bridgeMac", "routeMetric")}])
        self.assertFalse(uplink.checkpoint_file().exists())
        self.assertTrue(uplink.netplan_config_file(plan).exists())
        self.assertTrue(self.wifi_file.exists())

    def test_refresh_rejects_missing_netplan_proof_fields_without_reverification(self):
        plan = self.preflight()
        with mock.patch.object(uplink, "call", side_effect=self.commands):
            uplink.arm(plan)
        with mock.patch.object(uplink, "verify", return_value=True), \
             mock.patch.object(uplink, "call", side_effect=self.commands):
            uplink.confirm()
        path = uplink.STATE / "managed-uplink.json"
        proof = json.loads(path.read_text())
        del proof["bridgeMac"]
        path.write_text(json.dumps(proof))
        with mock.patch.object(uplink, "verify") as verify:
            with self.assertRaisesRegex(ValueError, "lacks bridge MAC"):
                uplink.refresh()
            verify.assert_not_called()

if __name__=="__main__":
    main()
