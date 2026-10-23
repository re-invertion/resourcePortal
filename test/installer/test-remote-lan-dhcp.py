#!/usr/bin/env python3
"""Prove the udhcpc hook never writes Docker overlay routes or DNS."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[2]/"packages/resourceportal-api/src/networking/remote-lan-dhcp.sh"

class DhcpScriptTest(unittest.TestCase):
    def run_hook(self, event, interface="rp-a-12345678", ip="192.168.50.120",
                 subnet="255.255.255.0", expected_cidr="192.168.50.0/24"):
        with tempfile.TemporaryDirectory(prefix="rp-lan-dhcp-") as folder:
            mock=Path(folder)/"ip"
            mock.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RP_IP_LOG\"\n")
            mock.chmod(0o755)
            log=Path(folder)/"actions"
            env={**os.environ,"PATH":folder+os.pathsep+os.environ.get("PATH",""),
                 "RP_IP_LOG":str(log),"interface":interface,"ip":ip,"subnet":subnet}
            if expected_cidr is not None:
                env["RP_REMOTE_LAN_CIDR"]=expected_cidr
            else:
                env.pop("RP_REMOTE_LAN_CIDR",None)
            result=subprocess.run(["sh",str(SCRIPT),event],env=env,
                                  text=True,capture_output=True,timeout=4)
            actions=log.read_text().splitlines() if log.exists() else []
            return result,actions

    def test_bound_does_not_change_default_route_or_resolver(self):
        result,actions=self.run_hook("bound")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(actions,[
            "-4 address flush dev rp-a-12345678 scope global",
            "-4 address add 192.168.50.120/24 dev rp-a-12345678",
            "link set dev rp-a-12345678 up",
        ])

    def test_renew_and_deconfig_only_touch_owned_l2_interface(self):
        result,actions=self.run_hook("renew",subnet="255.255.254.0",
                                     expected_cidr="192.168.50.0/23")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(actions[0],"-4 address flush dev rp-a-12345678 scope global")
        self.assertIn("192.168.50.120/23",actions[1])
        result,actions=self.run_hook("deconfig")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(actions,["-4 address flush dev rp-a-12345678 scope global"])

    def test_rejects_unauthorized_dhcp_lease_before_any_address_change(self):
        cases=[
            {"expected_cidr":None},
            {"expected_cidr":"0.0.0.0/0"},
            {"expected_cidr":"192.168.51.0/24"},
            {"expected_cidr":"192.168.50.7/24"},
            {"expected_cidr":"192.168.50.0/25"},
            {"subnet":"0.0.0.0"},
            {"subnet":"255.255.0.0"},
            {"ip":"192.168.50.0"},
            {"ip":"192.168.50.255"},
            {"ip":"192.168.51.4"},
            {"ip":"192.168.50.256"},
            {"ip":"192.168.50.01"},
            {"ip":"192.168.50.1.2"},
        ]
        for case in cases:
            with self.subTest(case=case):
                result,actions=self.run_hook("bound",**case)
                self.assertNotEqual(result.returncode,0,case)
                self.assertEqual(actions,[],case)

    def test_renew_removes_stale_previous_lan_address(self):
        result,actions=self.run_hook("renew",ip="192.168.50.122")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(actions,[
            "-4 address flush dev rp-a-12345678 scope global",
            "-4 address add 192.168.50.122/24 dev rp-a-12345678",
            "link set dev rp-a-12345678 up",
        ])

    def test_never_mutates_non_rp_interface(self):
        for iface in ("eth0","wg0","docker0","rp-a-1234;id"):
            result,actions=self.run_hook("bound",interface=iface)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(actions,[])

    def test_rejects_invalid_or_noncontiguous_netmask(self):
        for mask in ("255.0.255.0","255.255.255.3","255.255.255.256"):
            result,actions=self.run_hook("bound",subnet=mask)
            self.assertNotEqual(result.returncode,0,mask)
            self.assertEqual(actions,[])

if __name__=="__main__":
    unittest.main()
