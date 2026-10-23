#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
AGENT_FILE = ROOT / "packages/resourceportal-api/src/networking/gate-lan-agent.py"
spec = importlib.util.spec_from_file_location("resourceportal_gate_lan", AGENT_FILE)
agent = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = agent
spec.loader.exec_module(agent)

GATE = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
APP = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
ATTACHMENT = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111"
NETWORK = "aaaaaaaa-bbbb-4ccc-8ddd-121212121212"
ITEM = {"id":ATTACHMENT, "singleAppId":APP, "networkId":NETWORK,
        "lanCidr":"192.168.50.0/24", "lanInterface":"eth1",
        "macAddress":"02:aa:bb:cc:dd:ee"}
CONF = {"gateId":GATE,"tenantId":TENANT,"lanAttachmentProtocol":1,
        "serverPublicKey":"A" * 43 + "=",
        "serverTunnelAddress":"100.96.0.1/30","tunnelAddress":"100.96.0.2/30",
        "lanAttachments":[ITEM]}
LINKS=[{"ifname":"eth1","ifindex":4,"link_type":"ether","operstate":"UP"}]
ADDR=[{"ifname":"eth1","addr_info":[]}]
ROUTES=[{"dst":"default","dev":"eth0"}]


class GateLanAgentTest(unittest.TestCase):
    def test_gre_names_and_key_derive_from_authenticated_identity(self):
        dev,br,chain,key=agent.names(GATE,TENANT,ATTACHMENT,"eth1")
        self.assertRegex(dev,r"^rp-l2-[0-9a-f]{8}$")
        self.assertRegex(br,r"^rp-gb-[0-9a-f]{8}$")
        self.assertRegex(chain,r"^rp_[0-9a-f]{12}$")
        self.assertNotEqual(dev,agent.names(GATE,TENANT,APP,"eth1")[0])
        self.assertEqual(agent.underlay(CONF),("100.96.0.2","100.96.0.1"))
        with self.assertRaises(ValueError):
            agent.underlay({**CONF,"serverTunnelAddress":"100.96.0.1/32"})

    def test_never_bridges_management_ip_or_route(self):
        with self.assertRaisesRegex(ValueError,"management"):
            agent.validate_link("eth1","rp-gb-x",GATE,LINKS,
                [{"ifname":"eth1","addr_info":[{"family":"inet","local":"192.168.50.2"}]}],ROUTES)
        with self.assertRaisesRegex(ValueError,"default route"):
            agent.validate_link("eth1","rp-gb-x",GATE,LINKS,ADDR,
                [{"dst":"default","dev":"eth1"}])
        with self.assertRaisesRegex(ValueError,"Ethernet"):
            agent.validate_link("wlan0","rp-gb-x",GATE,
                [{"ifname":"wlan0","ifindex":3,"link_type":"none","operstate":"UP"}],ADDR,ROUTES)

    def test_filter_is_installed_before_remote_tunnel_joins_bridge(self):
        actions=[]
        def call(*args,**kwargs):
            actions.append(args)
            return ""
        with patch.object(agent,"device_state",return_value=(LINKS,ADDR,ROUTES)),\
             patch.object(agent,"call",side_effect=call):
            agent.apply_one(GATE,TENANT,ATTACHMENT,ITEM,"100.96.0.2","100.96.0.1")
        join_indices=[i for i,cmd in enumerate(actions) if cmd[:4]==("ip","link","set","dev")
                      and cmd[-2]=="master"]
        tunnel,bridge,chain,key=agent.names(GATE,TENANT,ATTACHMENT,"eth1")
        tunnel_join=[i for i in join_indices if actions[i][4]==tunnel][0]
        nft_rules=[i for i,cmd in enumerate(actions) if cmd[:4]==("nft","add","rule","bridge")]
        self.assertEqual(len(nft_rules),6)
        self.assertTrue(all(i<tunnel_join for i in nft_rules))
        self.assertEqual(sum(1 for cmd in actions if cmd[:4]==("ip","link","set","dev") and
                             cmd[4]=="eth0"),0)

    def test_revocation_does_not_disconnect_other_apps_from_shared_bridge(self):
        tun,br,chain,_=agent.names(GATE,TENANT,ATTACHMENT,"eth1")
        linklist=[{**LINKS[0],"master":br},
                  {"ifname":br,"ifalias":"rp-lan:"+GATE+":eth1",
                   "linkinfo":{"info_kind":"bridge"}},
                  {"ifname":tun,"master":br}]
        actions=[]
        with patch.object(agent,"device_state",return_value=(linklist,ADDR,ROUTES)),\
             patch.object(agent,"call",side_effect=lambda *args,**kwargs:actions.append(args) or ""):
            agent.remove_one(GATE,TENANT,ATTACHMENT,ITEM,
                             {APP:{**ITEM,"lanInterface":"eth1"}},
                             {ATTACHMENT:ITEM})
        self.assertFalse(any(cmd[0]=="ip" and cmd[-1]=="nomaster" for cmd in actions))
        self.assertFalse(any(cmd==("ip","link","delete",br) for cmd in actions))

    def test_l2_handshake_is_bound_to_exact_rp_public_key(self):
        rp_key = "A" * 43 + "="
        foreign_key = "B" * 43 + "="
        now = 1_800_000_000
        def check(output, key=rp_key):
            with patch.object(agent, "call", return_value=output), \
                 patch.object(agent.time, "time", return_value=now):
                return agent.is_handshake_recent(key)
        self.assertTrue(check(f"{rp_key} {now - 10}\n"))
        self.assertFalse(check(f"{foreign_key} {now - 1}\n"))
        self.assertFalse(check(f"{foreign_key} {now - 1}\n{rp_key} {now - 100}\n"))
        self.assertTrue(check(f"{foreign_key} {now - 1}\n{rp_key} {now - 10}\n"))
        self.assertFalse(check(f"{rp_key} {now - 10}\n{rp_key} {now - 9}\n"))
        self.assertFalse(check(f"{rp_key} {now + 1}\n"))
        self.assertFalse(check(f"{rp_key} garbage\n"))
        self.assertFalse(check(f"{rp_key} {now - 10}\n", key="invalid"))

    def test_missing_handshake_prevents_all_new_l2_bridging(self):
        with patch.object(agent,"is_handshake_recent",return_value=False) as handshake,\
             patch.object(agent,"apply_one") as apply:
            with self.assertRaisesRegex(RuntimeError,"handshake"):
                agent.reconcile(CONF,{"attachments":{}})
            handshake.assert_called_once_with(CONF["serverPublicKey"])
            apply.assert_not_called()

    def test_revocation_runs_even_if_tunnel_is_not_authenticated(self):
        actions=[]
        existing={"gateId":GATE,"tenantId":TENANT,"attachments":{ATTACHMENT:{
            "lanInterface":"eth1","macAddress":"02:aa:bb:cc:dd:ee",
            "singleAppId":APP,"networkId":NETWORK,"lanCidr":"192.168.50.0/24"}}}
        tun,br,chain,_=agent.names(GATE,TENANT,ATTACHMENT,"eth1")
        links=[{**LINKS[0],"master":br},{"ifname":br,
               "ifalias":"rp-lan:"+GATE+":eth1","linkinfo":{"info_kind":"bridge"}},
               {"ifname":tun,"master":br}]
        with patch.object(agent,"device_state",return_value=(links,ADDR,ROUTES)),\
             patch.object(agent,"call",side_effect=lambda *args,**kwargs: actions.append(args) or ""),\
             patch.object(agent,"is_handshake_recent",return_value=False):
            result=agent.reconcile({**CONF,"lanAttachments":[]},existing)
        self.assertEqual(result["attachments"],{})
        self.assertIn(("ip","link","delete",tun),actions)
        self.assertIn(("ip","link","delete",br),actions)

    def test_failed_filter_setup_rolls_back_new_bridge_and_port(self):
        actions = []
        tunnel, bridge, chain, _ = agent.names(GATE, TENANT, ATTACHMENT, "eth1")

        def failing_call(*args, **kwargs):
            actions.append(args)
            if args[:4] == ("nft", "add", "chain", "bridge"):
                raise RuntimeError("nft setup denied")
            return ""

        with patch.object(agent, "device_state", return_value=(LINKS, ADDR, ROUTES)), \
             patch.object(agent, "call", side_effect=failing_call):
            with self.assertRaisesRegex(RuntimeError, "nft setup denied"):
                agent.apply_one(GATE, TENANT, ATTACHMENT, ITEM,
                                "100.96.0.2", "100.96.0.1")
        self.assertIn(("ip", "link", "set", "dev", "eth1", "nomaster"), actions)
        self.assertIn(("ip", "link", "delete", bridge), actions)
        self.assertIn(("ip", "link", "delete", tunnel), actions)

    def test_failed_batch_revokes_all_newly_added_l2_endpoints(self):
        second_id = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222"
        next_config = {**CONF, "lanAttachments": [
            ITEM, {**ITEM, "id":second_id,
                   "singleAppId":"aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
                   "macAddress":"02:aa:bb:cc:dd:ff"}]}
        with patch.object(agent,"is_handshake_recent",return_value=True), \
             patch.object(agent,"apply_one",side_effect=[None, RuntimeError("second bridge failed")]) as apply, \
             patch.object(agent,"remove_one") as remove:
            with self.assertRaisesRegex(RuntimeError,"second bridge failed"):
                agent.reconcile(next_config, {"attachments":{}})
            self.assertEqual(apply.call_count,2)
            self.assertEqual(remove.call_count,1)
            self.assertEqual(remove.call_args.args[2],ATTACHMENT)

    def test_failed_batch_cleanup_persists_tombstone(self):
        second_id = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222"
        next_config = {**CONF, "lanAttachments": [
            ITEM, {**ITEM, "id":second_id,
                   "singleAppId":"aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
                   "macAddress":"02:aa:bb:cc:dd:ff"}]}
        with patch.object(agent,"is_handshake_recent",return_value=True), \
             patch.object(agent,"apply_one",side_effect=[None, RuntimeError("second failed")]), \
             patch.object(agent,"remove_one",side_effect=RuntimeError("cannot revoke")), \
             patch.object(agent,"save_state") as save:
            with self.assertRaisesRegex(RuntimeError,"Unsafe partial"):
                agent.reconcile(next_config, {"attachments":{}})
            self.assertIn(ATTACHMENT,save.call_args.args[0]["attachments"])

    def test_offline_revoke_all_uses_only_durable_gate_identity(self):
        state={"gateId":GATE,"tenantId":TENANT,"attachments":{ATTACHMENT:ITEM}}
        with patch.object(agent.os,"geteuid",return_value=0), \
             patch.object(agent.sys,"argv",["gate-lan-agent.py","--revoke-all"]), \
             patch.object(agent,"load_state",return_value=state), \
             patch.object(agent,"reconcile",return_value={"attachments":{}}) as reconcile, \
             patch.object(agent,"save_state") as saved:
            agent.main()
        config,old=reconcile.call_args.args
        self.assertEqual(config["lanAttachments"],[])
        self.assertEqual(config["gateId"],GATE)
        self.assertEqual(config["tenantId"],TENANT)
        saved.assert_called_once()

    def test_cross_tenant_state_is_not_deleted_or_reused(self):
        foreign={"gateId":GATE,"tenantId":"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
                 "attachments":{}}
        with self.assertRaisesRegex(ValueError,"different Gate"):
            agent.reconcile({**CONF,"lanAttachments":[]},foreign)


if __name__=="__main__":
    unittest.main()
