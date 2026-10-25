#!/usr/bin/env python3
"""Fail-closed Gate bridge ownership and persistent managed-uplink regression."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main, mock

ROOT = Path(__file__).resolve().parent.parent
source = ROOT / "packages/resourceportal-api/src/networking/gate-lan-agent.py"
spec = importlib.util.spec_from_file_location("rp_gate_lan_agent", source)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
AID = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
BRIDGE = agent.names(GATE, TENANT, AID, "eth0")[1]
ALIAS = "rp-lan:" + GATE + ":eth0"


class ManagedUplinkTests(TestCase):
    def state(self):
        links = [
            {"ifname": "eth0", "link_type": "ether", "operstate": "UP", "master": BRIDGE},
            {"ifname": BRIDGE, "linkinfo": {"info_kind": "bridge"}, "ifalias": ALIAS}
        ]
        addresses = [
            {"ifname": "eth0", "addr_info": []},
            {"ifname": BRIDGE, "addr_info": [
                {"family": "inet", "local": "192.168.100.11", "prefixlen": 24}
            ]}
        ]
        routes = [{"dst": "default", "dev": BRIDGE, "gateway": "192.168.100.1"}]
        return links, addresses, routes

    def checkpoint(self):
        return {"gateId": GATE, "device": "eth0", "bridge": BRIDGE,
                "state": "Ready", "rollbackTested": True,
                "verifiedAt": __import__("time").time(), "networkCidr": "192.168.100.0/24"}

    def validate(self, links, addresses, routes, proof):
        with mock.patch.object(agent, "MANAGED") as state:
            state.is_file.return_value = True
            state.is_symlink.return_value = False
            state.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o100600)
            state.read_text.return_value = __import__("json").dumps(proof)
            return agent.validate_link("eth0", BRIDGE, GATE, links, addresses,
                                       routes, "ManagedSharedUplink")

    def test_valid_preverified_bridge_does_not_migrate_nic(self):
        self.assertTrue(self.validate(*self.state(), self.checkpoint()))

    def test_managed_uplink_fails_closed_without_local_checkpoint(self):
        links, addresses, routes = self.state()
        with mock.patch.object(agent, "MANAGED") as state:
            state.is_file.return_value = False
            with self.assertRaisesRegex(ValueError, "checkpoint"):
                agent.validate_link("eth0", BRIDGE, GATE, links, addresses,
                                    routes, "ManagedSharedUplink")

    def test_wrong_owner_and_missing_bridge_rejected(self):
        links, addresses, routes = self.state()
        with self.assertRaises(ValueError):
            self.validate(links[:1], addresses, routes, self.checkpoint())
        bad = dict(self.checkpoint(), gateId=TENANT)
        with self.assertRaisesRegex(ValueError, "authorization"):
            self.validate(links, addresses, routes, bad)

    def test_no_phys_ip_and_gateway_must_be_on_bridge(self):
        links, addresses, routes = self.state()
        addresses[0]["addr_info"] = [{"family": "inet6", "local": "fe80::1"}]
        with self.assertRaisesRegex(ValueError, "Management address"):
            self.validate(links, addresses, routes, self.checkpoint())
        links, addresses, routes = self.state()
        routes[0]["dev"] = "eth0"
        with self.assertRaisesRegex(ValueError, "default gateway"):
            self.validate(links, addresses, routes, self.checkpoint())

    def test_gate_reports_verified_segment_without_attachment_cidr(self):
        links, addresses, routes = self.state()
        with mock.patch.object(agent, "MANAGED") as state, \
             mock.patch.object(agent, "device_state", return_value=(links, addresses, routes)):
            state.is_file.return_value = True
            state.is_symlink.return_value = False
            state.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o100600)
            state.read_text.return_value = __import__("json").dumps(self.checkpoint())
            segment = agent.observed_managed_segment()
        self.assertEqual(segment["networkCidr"], "192.168.100.0/24")
        self.assertEqual(segment["netmask"], "255.255.255.0")
        self.assertEqual(segment["gateway"], "192.168.100.1")
        self.assertEqual(segment["bridge"], BRIDGE)
        self.assertEqual(segment["state"], "Ready")

    def test_managed_detach_never_deletes_management_bridge(self):
        tunnel = agent.names(GATE, TENANT, AID, "eth0")[0]
        links, _, _ = self.state()
        links.append({"ifname": tunnel, "master": BRIDGE})
        item = {"lanInterface": "eth0", "uplinkMode": "ManagedSharedUplink"}
        with mock.patch.object(agent, "device_state", return_value=(links, [], [])), \
             mock.patch.object(agent, "nft_remove"), \
             mock.patch.object(agent, "call") as network_call:
            agent.remove_one(GATE, TENANT, AID, item, {}, {AID: item})
            network_call.assert_called_once_with("ip", "link", "delete", tunnel)

    def test_stale_proof_and_wrong_network_are_denied(self):
        links, addresses, routes = self.state()
        stale = dict(self.checkpoint(), verifiedAt=0)
        with self.assertRaisesRegex(ValueError, "authorization"):
            self.validate(links, addresses, routes, stale)
        wrong = dict(self.checkpoint(), networkCidr="192.168.101.0/24")
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.validate(links, addresses, routes, wrong)

    def test_legacy_dedicated_record_normalizes_without_recreate(self):
        legacy = {"lanInterface": "eth1", "macAddress": "02:00:00:00:00:01",
                  "singleAppId": AID, "networkId": AID, "lanCidr": "192.168.100.0/24"}
        config = {"gateId": GATE, "tenantId": TENANT, "lanAttachmentProtocol": 1,
                  "lanAttachments": [dict(legacy, id=AID)]}
        current = {"gateId": GATE, "tenantId": TENANT, "attachments": {AID: legacy}}
        tunnel, bridge, _, _ = agent.names(GATE, TENANT, AID, "eth1")
        with mock.patch.object(agent, "is_handshake_recent", return_value=True), \
             mock.patch.object(agent, "underlay", return_value=("100.96.0.2", "100.96.0.1")), \
             mock.patch.object(agent, "device_state", return_value=([{"ifname": tunnel, "master": bridge}], [], [])), \
             mock.patch.object(agent, "apply_one") as apply:
            result = agent.reconcile(config, current)
            apply.assert_not_called()
            self.assertEqual(result["attachments"][AID]["uplinkMode"], "DedicatedUnnumbered")

    def test_reconnect_rebuilds_only_missing_app_endpoint(self):
        item = {"id": AID, "singleAppId": AID, "networkId": AID,
                "lanInterface": "eth1", "lanCidr": "192.168.100.0/24",
                "macAddress": "02:00:00:00:00:01"}
        current = {"gateId": GATE, "tenantId": TENANT,
                   "attachments": {AID: dict({k: v for k, v in item.items() if k != "id"}, uplinkMode="DedicatedUnnumbered")}}
        config = {"gateId": GATE, "tenantId": TENANT, "lanAttachmentProtocol": 1,
                  "lanAttachments": [item]}
        with mock.patch.object(agent, "is_handshake_recent", return_value=True), \
             mock.patch.object(agent, "underlay", return_value=("100.96.0.2", "100.96.0.1")), \
             mock.patch.object(agent, "device_state", return_value=([], [], [])), \
             mock.patch.object(agent, "apply_one") as apply:
            agent.reconcile(config, current)
            apply.assert_called_once()

    def test_versioned_addressing_update_revokes_old_kernel_endpoint_before_regrant(self):
        current_item = {"singleAppId": AID, "networkId": AID, "lanInterface": "eth1",
                        "lanCidr": "192.168.100.0/24", "macAddress": "02:00:00:00:00:01",
                        "uplinkMode": "DedicatedUnnumbered", "addressMode": "DHCP",
                        "staticAddress": None, "staticGateway": None,
                        "configurationRevision": 1}
        updated_item = dict(current_item, macAddress="02:00:00:00:00:02",
                            configurationRevision=2)
        config = {"gateId": GATE, "tenantId": TENANT, "lanAttachmentProtocol": 1,
                  "lanAttachments": [dict(updated_item, id=AID)]}
        state = {"gateId": GATE, "tenantId": TENANT, "attachments": {AID: current_item}}
        calls = []
        with mock.patch.object(agent, "is_handshake_recent", return_value=True), \
             mock.patch.object(agent, "underlay", return_value=("100.96.0.2", "100.96.0.1")), \
             mock.patch.object(agent, "remove_one", side_effect=lambda *_: calls.append("remove")), \
             mock.patch.object(agent, "apply_one", side_effect=lambda *_: calls.append("apply")), \
             mock.patch.object(agent, "save_state", side_effect=lambda *_: calls.append("checkpoint")):
            result = agent.reconcile(config, state)
        self.assertEqual(calls, ["remove", "checkpoint", "apply"])
        self.assertEqual(result["attachments"][AID]["configurationRevision"], 2)

        state = {"gateId": GATE, "tenantId": TENANT, "attachments": {AID: current_item}}
        config["lanAttachments"][0]["configurationRevision"] = 1
        with mock.patch.object(agent, "is_handshake_recent", return_value=True), \
             mock.patch.object(agent, "underlay", return_value=("100.96.0.2", "100.96.0.1")), \
             mock.patch.object(agent, "remove_one") as remove:
            with self.assertRaisesRegex(ValueError, "newer revision"):
                agent.reconcile(config, state)
            remove.assert_not_called()

    def netplan_state(self):
        links, addresses, routes = self.state()
        links[1]["address"] = "dc:a6:32:10:20:30"
        links.append({"ifname": "wlan0", "link_type": "ether", "operstate": "UP"})
        addresses.append({"ifname": "wlan0", "addr_info": [
            {"family": "inet", "local": "192.168.100.143", "prefixlen": 24}]})
        routes[0]["metric"] = 100
        routes.append({"dst": "default", "dev": "wlan0",
                       "gateway": "192.168.100.1", "metric": 600})
        proof = dict(self.checkpoint(), manager="NetplanNetworkManager",
                     bridgeMac="dc:a6:32:10:20:30", routeMetric=100,
                     gateway="192.168.100.1")
        return links, addresses, routes, proof

    def test_netplan_wifi_backup_allows_observation_and_attachment_application(self):
        links, addresses, routes, proof = self.netplan_state()
        self.assertTrue(self.validate(links, addresses, routes, proof))
        with mock.patch.object(agent, "MANAGED") as state, \
             mock.patch.object(agent, "device_state", return_value=(links, addresses, routes)), \
             mock.patch.object(agent, "call") as call, \
             mock.patch.object(agent, "nft_install"):
            state.is_file.return_value = True
            state.is_symlink.return_value = False
            state.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o100600)
            state.read_text.return_value = __import__("json").dumps(proof)
            observed = agent.observed_managed_segment()
            self.assertEqual(observed["gateway"], "192.168.100.1")
            self.assertEqual(observed["state"], "Ready")
            agent.apply_one(GATE, TENANT, AID, {
                "lanInterface": "eth0", "uplinkMode": "ManagedSharedUplink",
                "macAddress": "02:00:00:00:00:01"}, "100.96.0.2", "100.96.0.1")
            commands = [c.args for c in call.call_args_list]
            self.assertTrue(any(c[:4] == ("ip", "link", "add",
                                           agent.names(GATE, TENANT, AID, "eth0")[0])
                                for c in commands))
            self.assertFalse(any(c[:4] == ("ip", "link", "add", BRIDGE)
                                 for c in commands))

    def test_netplan_backup_route_fails_closed_on_competition_and_spoofing(self):
        for mutation in ("equal", "preferred", "extra", "ethernet", "mac", "primary"):
            links, addresses, routes, proof = self.netplan_state()
            if mutation == "equal":
                routes[1]["metric"] = 100
            elif mutation == "preferred":
                routes[1]["metric"] = 50
            elif mutation == "extra":
                routes.append(dict(routes[1]))
            elif mutation == "ethernet":
                routes[1]["dev"] = "eth1"
            elif mutation == "mac":
                links[1]["address"] = "02:00:00:00:00:09"
            else:
                routes[0]["metric"] = 200
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.validate(links, addresses, routes, proof)

    def test_unknown_mode_fails_closed(self):
        links, addresses, routes = self.state()
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            agent.validate_link("eth0", BRIDGE, GATE, links, addresses, routes, "Unknown")


if __name__ == "__main__":
    main()
