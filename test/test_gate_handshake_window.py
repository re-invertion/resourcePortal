import importlib.util
from pathlib import Path
from unittest import TestCase, mock

SPEC = importlib.util.spec_from_file_location("gate_agent", Path(__file__).resolve().parents[1] / "packages/resourceportal-api/src/networking/gate-lan-agent.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
PEER = "A" * 43 + "="
OTHER = "B" * 43 + "="
NOW = 1800000000

class GateHandshakeAge(TestCase):
    def test_boundary_for_reconcile_and_observed_l2(self):
        for age, accepted in [(89,True),(90,True),(120,True),(150,False),(180,False)]:
            with self.subTest(age=age), mock.patch.object(gate.time,"time",return_value=NOW), \
                 mock.patch.object(gate,"call",return_value=f"{PEER} {NOW-age}\n"), \
                 mock.patch.object(gate,"device_state",return_value=([],[],[])):
                self.assertEqual(gate.is_handshake_recent(PEER), accepted)
                # A recent authenticated peer remains necessary for L2 observation.
                result=gate.observed_attachment_proofs({"gateId":"g", "tenantId":"t", "serverPublicKey":PEER,"attachments":{}})
                self.assertEqual(result, [])
                if not accepted:
                    with mock.patch.object(gate,"device_state",side_effect=AssertionError("must not inspect L2 without handshake")):
                        self.assertEqual(gate.observed_attachment_proofs({"gateId":"g","tenantId":"t","serverPublicKey":PEER,"attachments":{}}), [])

    def test_no_foreign_duplicate_or_absent_peer_authorized(self):
        for lines in [f"{OTHER} {NOW-1}\n", f"{PEER} 0\n",f"{PEER} {NOW-1}\n{PEER} {NOW-1}\n",""]:
            with self.subTest(lines=lines), mock.patch.object(gate.time,"time",return_value=NOW),mock.patch.object(gate,"call",return_value=lines):
                self.assertFalse(gate.is_handshake_recent(PEER))
                self.assertEqual(gate.observed_attachment_proofs({"gateId":"g","tenantId":"t","serverPublicKey":PEER,"attachments":{}}),[])

    def test_observed_proof_retains_mac_ownership_revision_and_fdb_checks(self):
        aid="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        identity={"gateId":"bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                  "tenantId":"cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                  "serverPublicKey":PEER,
                  "attachments":{aid:{"lanInterface":"eth0","macAddress":"62:bc:1c:51:53:ef",
                                      "singleAppId":"dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                                      "configurationRevision":4}}}
        tunnel,bridge,_,_=gate.names(identity["gateId"],identity["tenantId"],aid,"eth0")
        links=[{"ifname":tunnel,"master":bridge,"linkinfo":{"info_kind":"gretap"}},
               {"ifname":bridge,"ifalias":"rp-lan:"+identity["gateId"]+":eth0",
                "linkinfo":{"info_kind":"bridge"}}]
        def call(*args):
            if args[0]=="wg": return f"{PEER} {NOW-120}\n"
            if args[0]=="bridge": return "62:bc:1c:51:53:ef dev "+tunnel+" master dynamic"
            raise AssertionError(args)
        with mock.patch.object(gate.time,"time",return_value=NOW), \
             mock.patch.object(gate,"call",side_effect=call), \
             mock.patch.object(gate,"device_state",return_value=(links,[],[])):
            proofs=gate.observed_attachment_proofs(identity)
            self.assertEqual(len(proofs),1)
            self.assertEqual(proofs[0]["configurationRevision"],4)
            self.assertTrue(proofs[0]["gatewayTunnelOwned"])
            self.assertTrue(proofs[0]["bridgeOwned"])
            self.assertTrue(proofs[0]["macLearnedOnTunnel"])
            links[0]["master"]="unowned"
            self.assertEqual(gate.observed_attachment_proofs(identity),[])
