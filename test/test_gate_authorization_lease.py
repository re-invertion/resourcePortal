#!/usr/bin/env python3
"""Sandbox-only Gate authorization lease tests: no WireGuard or host mutation."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess
import uuid
from copy import deepcopy
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "packages/resourceportal-api/src/networking/gate-authorization-lease.py"
spec = importlib.util.spec_from_file_location("gate_authorization_lease", MODULE)
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)

# The local-state pathname is a security boundary: unlike unit tests that
# inject temporary paths, the installed Gate agent and watchdog MUST read
# the exact same persistent state file.
ORIGINAL_L2_STATE = lease.L2_STATE
LAN_AGENT_MODULE = MODULE.with_name("gate-lan-agent.py")
lan_spec = importlib.util.spec_from_file_location("gate_lan_agent_422", LAN_AGENT_MODULE)
lan = importlib.util.module_from_spec(lan_spec)
sys.modules[lan_spec.name] = lan
lan_spec.loader.exec_module(lan)

GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
APP = "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd"
ATTACHMENT = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
NETWORK = "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc"
NONCE = "a" * 64
GRANT = {"attachmentId": ATTACHMENT, "tenantId": TENANT, "gateId": GATE,
         "singleAppId": APP, "networkId": NETWORK,
         "macAddress": "02:aa:bb:cc:dd:ee", "configurationRevision": 2}
RESPONSE = {"gateId": GATE, "tenantId": TENANT, "lanAttachmentProtocol": 1,
            "lanAttachments": [{"id": ATTACHMENT, "networkId": NETWORK,
                                "singleAppId": APP, "macAddress": GRANT["macAddress"],
                                "configurationRevision": 2, "status": "Active"}],
            "authorizationLease": {"protocol": 1, "nonce": NONCE,
                                   "gateId": GATE, "tenantId": TENANT,
                                   "ttlSeconds": 600, "grants": [GRANT]}}


class GateLeaseTests(unittest.TestCase):
    def test_production_state_path_matches_installed_lan_agent(self):
        self.assertEqual(ORIGINAL_L2_STATE, lan.STATE)
        self.assertEqual(ORIGINAL_L2_STATE, Path("/etc/resourceportal-gate/lan-state.json"))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.t = 100
        self.patchers = [
            patch.object(lease, "STATE_DIR", root),
            patch.object(lease, "LEASE_FILE", root / "authorization.json"),
            patch.object(lease, "GATE_STATE", root / "gate.json"),
            patch.object(lease, "L2_STATE", root / "lan-state.json"),
            patch.object(lease, "boot_id", lambda: "boot-1"),
            patch.object(lease, "boot_time", lambda: self.t),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        lease.GATE_STATE.write_text('{"gateId": "' + GATE + '"}')
        import json
        lease.L2_STATE.write_text(json.dumps({"gateId":GATE,"tenantId":TENANT,
            "attachments":{ATTACHMENT:{
                "singleAppId":APP,"networkId":NETWORK,
                "configurationRevision":2,"macAddress":GRANT["macAddress"],
            }}}))

    def test_deadline_uses_boottime_and_never_extends_on_failed_exchange(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        self.assertEqual(lease.read()["deadline"], 700)
        self.t = 699
        self.assertIsNotNone(lease.read())
        self.t = 700
        self.assertIsNone(lease.read())
        self.assertIsNone(lease.read())

    def test_replay_wrong_nonce_revision_scope_and_bad_ttl_rejected(self):
        from copy import deepcopy
        for mutation in ("nonce", "ttl", "gate", "revision", "mac", "tenant"):
            item = deepcopy(RESPONSE)
            if mutation == "nonce":
                item["authorizationLease"]["nonce"] = "b" * 64
            if mutation == "ttl":
                item["authorizationLease"]["ttlSeconds"] = 601
            if mutation == "gate":
                item["authorizationLease"]["gateId"] = "wrong"
            if mutation == "revision":
                item["authorizationLease"]["grants"][0]["configurationRevision"] = 3
            if mutation == "mac":
                item["authorizationLease"]["grants"][0]["macAddress"] = "02:dd:dd:dd:dd:dd"
            if mutation == "tenant":
                item["authorizationLease"]["grants"][0]["tenantId"] = "wrong"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                lease.renew(item, NONCE)
            self.assertIsNone(lease.read())

    def test_443_second_partition_survives_but_watchdog_revokes_after_original_deadline(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        self.t = 543  # 443 s after issuance; HTTPS is unavailable
        self.assertIsNotNone(lease.read())
        ticks = 0
        def step(_seconds):
            nonlocal ticks
            ticks += 1
            if ticks == 1:
                self.t = 701  # Beyond original 600 s grant
            else:
                raise StopIteration("test watchdog cycle completed")
        with patch.object(lease.time, "sleep", side_effect=step),              patch.object(lease, "revoke") as revoked:
            with self.assertRaises(StopIteration):
                lease.watch()
            revoked.assert_called_once_with()
        self.assertIsNone(lease.read())
        self.assertFalse(lease.LEASE_FILE.exists())

    def test_failed_lan_cleanup_still_shuts_down_wireguard(self):
        commands = []
        def local_run(argv, **_kwargs):
            commands.append(argv)
            if "--revoke-all" in argv:
                raise subprocess.TimeoutExpired("lan-agent", 20)
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(lease.subprocess, "run", side_effect=local_run):
            with self.assertRaises(subprocess.TimeoutExpired):
                lease.revoke()
        self.assertEqual(len(commands), 2)
        self.assertIn("--revoke-all", commands[0])
        self.assertEqual(commands[1], ["wg-quick", "down", "rp-gate"])

    def test_watchdog_retries_failed_revocation_and_always_attempts_wireguard_down(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        self.t = 701
        ticks = 0
        def step(_):
            nonlocal ticks
            ticks += 1
            if ticks == 2:
                raise StopIteration("end after retry")
        with patch.object(lease.time, "sleep", side_effect=step), \
             patch.object(lease, "revoke",
                          side_effect=[subprocess.TimeoutExpired("lan-agent", 20), None]) as revoke:
            with self.assertRaises(StopIteration):
                lease.watch()
            self.assertEqual(revoke.call_count, 2)
        self.assertFalse(lease.LEASE_FILE.exists())

    def test_live_only_transition_does_not_revoke_fresh_authenticated_200(self):
        from copy import deepcopy
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        live_response = deepcopy(RESPONSE)
        live_response["authorizationLease"]["grants"] = []
        # A successful 200 with a matching one-use nonce and no offline
        # grants is not a transport failure or an authorization revocation.
        self.assertFalse(lease.renew(live_response, NONCE))
        self.assertIsNone(lease.read())  # Not authorized for offline forwarding
        self.assertEqual(lease.read(allow_live=True)["mode"], "live")
        self.assertEqual(lease.read(allow_live=True)["deadline"], 145)
        ticks = 0
        with patch.object(lease, "revoke") as revoked:
            def step(_seconds):
                nonlocal ticks
                ticks += 1
                if ticks == 1:
                    self.assertEqual(revoked.call_count, 0)
                    self.t = 144
                elif ticks == 2:
                    self.assertEqual(revoked.call_count, 0)
                    self.t = 146
                else:
                    raise StopIteration("watchdog test completed")
            with patch.object(lease.time, "sleep", side_effect=step):
                with self.assertRaises(StopIteration):
                    lease.watch()
            revoked.assert_called_once_with()
            self.assertFalse(lease.LEASE_FILE.exists())

    def test_live_only_mode_invalidates_on_revision_reboot_and_never_extends_offline(self):
        from copy import deepcopy
        response = deepcopy(RESPONSE)
        response["authorizationLease"]["grants"] = []
        self.assertFalse(lease.renew(response, NONCE))
        self.assertIsNone(lease.read())  # Failed HTTPS must revoke immediately
        self.assertIsNotNone(lease.read(allow_live=True))
        local = json.loads(lease.L2_STATE.read_text())
        local["attachments"][ATTACHMENT]["configurationRevision"] = 3
        lease.L2_STATE.write_text(json.dumps(local))
        self.assertIsNone(lease.read(allow_live=True))
        local["attachments"][ATTACHMENT]["configurationRevision"] = 2
        lease.L2_STATE.write_text(json.dumps(local))
        with patch.object(lease, "boot_id", return_value="another-boot"):
            self.assertIsNone(lease.read(allow_live=True))
        self.t = 146
        self.assertIsNone(lease.read(allow_live=True))

    def test_transition_covers_old_and_new_state_before_live_only_renewal(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        newer = deepcopy(RESPONSE)
        new_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-gate-new-attachment"))
        new_app = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-gate-new-app"))
        new_net = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-gate-new-network"))
        new_mac = "02:aa:bb:cc:dd:ef"
        newer["lanAttachments"].append({
            "id": new_id, "singleAppId": new_app, "networkId": new_net,
            "macAddress": new_mac, "configurationRevision": 1,
            "status": "Provisioning"})
        newer["authorizationLease"]["grants"] = []  # No offline grace during provisioning
        lease.begin_transition(newer, NONCE)
        state = lease.read(allow_live=True)
        self.assertEqual(state["mode"], "transition")
        self.assertEqual(state["deadline"], 145)
        self.assertEqual(len(state["previous"]), 1)
        self.assertEqual(len(state["grants"]), 2)
        self.assertIsNone(lease.read())  # HTTPS failure never treats transition as offline
        # Simulate an atomic LAN state replacement between two 200ms watchdog
        # polls. A real previously reported P2 bug revoked here.
        ticks = 0
        def step(_):
            nonlocal ticks
            ticks += 1
            if ticks == 1:
                local = json.loads(lease.L2_STATE.read_text())
                local["attachments"][new_id] = {
                    "singleAppId": new_app, "networkId": new_net,
                    "macAddress": new_mac, "configurationRevision": 1}
                lease.L2_STATE.write_text(json.dumps(local))
                self.assertIsNotNone(lease.read(allow_live=True))
            elif ticks == 2:
                self.assertFalse(lease.renew(newer, NONCE))
                self.assertEqual(lease.read(allow_live=True)["mode"], "live")
            else:
                raise StopIteration("reconciliation complete")
        with patch.object(lease.time, "sleep", side_effect=step), \
             patch.object(lease, "revoke") as revoked:
            with self.assertRaises(StopIteration):
                lease.watch()
            revoked.assert_not_called()
        self.assertIsNone(lease.read())
        self.assertEqual(lease.read(allow_live=True)["mode"], "live")
        self.t = 146
        self.assertIsNone(lease.read(allow_live=True))

    def test_transition_rejects_replay_and_never_extends_expired_old_authority(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        with self.assertRaises(ValueError):
            lease.begin_transition(RESPONSE, "b" * 64)
        self.assertEqual(lease.read()["mode"], "lease")
        self.t = 700
        self.assertIsNone(lease.read())
        lease.begin_transition(RESPONSE, NONCE)
        transition = lease.read(allow_live=True)
        self.assertEqual(transition["previous"], [])
        self.assertIsNone(lease.read())  # Never permits disconnected continuation
        self.t = 746
        self.assertIsNone(lease.read(allow_live=True))

    def test_64_grants_fit_both_python_readers_but_65_are_rejected(self):
        newer = deepcopy(RESPONSE)
        newer["lanAttachments"] = []
        newer["authorizationLease"]["grants"] = []
        local = {"gateId":GATE,"tenantId":TENANT,"attachments":{}}
        for i in range(64):
            aid = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-grant-%d" % i))
            app = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-app-%d" % i))
            network = str(uuid.uuid5(uuid.NAMESPACE_DNS, "rp-network-%d" % i))
            mac = "02:aa:bb:%02x:cc:dd" % i
            entry = {"attachmentId":aid,"tenantId":TENANT,"gateId":GATE,
                     "singleAppId":app,"networkId":network,
                     "macAddress":mac,"configurationRevision":2}
            newer["authorizationLease"]["grants"].append(entry)
            newer["lanAttachments"].append({
                "id":aid,"singleAppId":app,"networkId":network,
                "macAddress":mac,"configurationRevision":2,"status":"Active"})
            local["attachments"][aid] = {
                "singleAppId":app,"networkId":network,
                "macAddress":mac,"configurationRevision":2}
        lease.L2_STATE.write_text(json.dumps(local))
        self.assertTrue(lease.renew(newer, NONCE))
        self.assertGreater(lease.LEASE_FILE.stat().st_size, 16_000)
        self.assertLessEqual(lease.LEASE_FILE.stat().st_size, lease.MAX_LEASE_BYTES)
        self.assertEqual(len(lease.read()["grants"]), 64)
        lease.begin_transition(newer, NONCE)
        self.assertEqual(len(lease.read(allow_live=True)["grants"]), 64)
        self.assertEqual(len(lease.read(allow_live=True)["previous"]), 64)
        self.assertIsNone(lease.read())  # 64-grant transition is NEVER offline
        self.assertLessEqual(lease.LEASE_FILE.stat().st_size, lease.MAX_LEASE_BYTES)
        self.assertTrue(lease.renew(newer, NONCE))
        # Verify the separate LAN/nft parser can actually read that file,
        # not only that the lease watchdog can parse its 64 grants.
        boot = Path(self.tmp.name)/"boot-id"
        boot.write_text("boot-1")
        original_path = Path
        def path_override(raw):
            if raw == "/run/resourceportal-gate/authorization.json":
                return lease.LEASE_FILE
            if raw == "/proc/sys/kernel/random/boot_id":
                return boot
            return original_path(raw)
        with patch.object(lan, "Path", side_effect=path_override), \
             patch.object(lan.time, "clock_gettime", return_value=100):
            self.assertEqual(lan.authorization_remaining(
                {"attachmentId":newer["authorizationLease"]["grants"][0]["attachmentId"],
                 **local["attachments"][newer["authorizationLease"]["grants"][0]["attachmentId"]]}),
                600)
        too_many = deepcopy(newer)
        too_many["authorizationLease"]["grants"].append(GRANT)
        too_many["lanAttachments"].append(RESPONSE["lanAttachments"][0])
        with self.assertRaises(ValueError):
            lease.renew(too_many, NONCE)

    def test_revision_change_or_locally_removed_attachment_invalidates_lease(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        import json
        local=json.loads(lease.L2_STATE.read_text())
        local["attachments"][ATTACHMENT]["configurationRevision"]=3
        lease.L2_STATE.write_text(json.dumps(local))
        self.assertIsNone(lease.read())
        local["attachments"].clear()
        lease.L2_STATE.write_text(json.dumps(local))
        self.assertIsNone(lease.read())

    def test_restart_and_partial_grants_fail_closed(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        lease.clear()  # New Gate process must perform this before its first request
        self.assertIsNone(lease.read())
        new = dict(RESPONSE)
        new["lanAttachments"] = RESPONSE["lanAttachments"] + [
            {"id": "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff", "status": "Provisioning"}]
        # Incomplete and also malformed new live scope must be rejected,
        # never mistaken for a valid downgrade.
        with self.assertRaises(ValueError):
            lease.renew(new, NONCE)
        self.assertIsNone(lease.read())

    def test_boot_identity_and_clock_rollback_do_not_extend_deadline(self):
        self.assertTrue(lease.renew(RESPONSE, NONCE))
        self.t = 99  # Artificial clock rollback; real CLOCK_BOOTTIME cannot roll back
        # A backwards jump larger than the initial max TTL fails closed,
        # rather than manufacturing an extra second of authority.
        self.assertIsNone(lease.read())
        self.t = 100
        with patch.object(lease, "boot_id", lambda: "new-boot"):
            self.assertIsNone(lease.read())


if __name__ == "__main__":
    unittest.main()
