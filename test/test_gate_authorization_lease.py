#!/usr/bin/env python3
"""Sandbox-only Gate authorization lease tests: no WireGuard or host mutation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "packages/resourceportal-api/src/networking/gate-authorization-lease.py"
spec = importlib.util.spec_from_file_location("gate_authorization_lease", MODULE)
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)

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
        self.assertFalse(lease.renew(new, NONCE))
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
