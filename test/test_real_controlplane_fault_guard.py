#!/usr/bin/env python3
"""Verify fault helper cannot issue docker/kill when called outside GitHub CI."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run-remote-lan-real-controlplane-fault.sh"
SMOKE = ROOT / "scripts" / "run-remote-lan-l2-dhcp-smoke.sh"


class RealFaultGuardTests(unittest.TestCase):
    def run_guard(self, changes):
        with tempfile.TemporaryDirectory() as tmp:
            fakebin = Path(tmp, "bin")
            fakebin.mkdir()
            flag = Path(tmp, "dangerous-command-fired")
            for cmd in ("docker", "kill", "ss", "ps"):
                script = fakebin / cmd
                script.write_text("#!/bin/sh\nprintf hit > " + str(flag) + "\nexit 1\n")
                script.chmod(0o755)
            env = {"PATH": str(fakebin) + ":/usr/bin:/bin",
                   "HOME": tmp, **changes}
            result = subprocess.run(
                ["bash", str(SCRIPT), "/tmp/tmp.test/prepare",
                 "/tmp/tmp.test/lease", "/tmp/tmp.test/outage", "/tmp/tmp.test/restore"],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=5, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing", result.stderr)
            self.assertFalse(flag.exists(), "Unsafe external process was invoked")

    def test_default_local_execution_rejected_without_touching_anything(self):
        self.run_guard({})

    def test_ci_like_flags_are_insufficient_without_actual_runner_directory(self):
        self.run_guard({"RP_LAN_REAL_CONTROL_PLANE_FAULT":"1",
                        "GITHUB_ACTIONS":"true","CI":"true",
                        "GITHUB_REPOSITORY":"re-invertion/resourcePortal",
                        "GITHUB_RUN_ID":"12345",
                        "RUNNER_TEMP":"/tmp/unsafe-pi"})

    def test_wrong_repository_rejected_before_any_docker_invocation(self):
        self.run_guard({"RP_LAN_REAL_CONTROL_PLANE_FAULT":"1",
                        "GITHUB_ACTIONS":"true","CI":"true",
                        "GITHUB_REPOSITORY":"wrong/repo",
                        "GITHUB_RUN_ID":"12345",
                        "RUNNER_TEMP":"/home/runner/work/_temp"})

    def test_disposable_gate_underlay_fault_is_fail_closed_and_restored(self):
        result = subprocess.run(["bash", "-n", str(SMOKE)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = SMOKE.read_text()
        begin = text.index('  if [ "$REAL_FAULT" = 1 ]; then',
                           text.index('PASS immediate local policy revoke'))
        end = text.index('  kill "$server_pid"', begin)
        fault = text[begin:end]
        self.assertIn('http://127.0.0.1:3000/api/health', fault)
        self.assertIn('ns "$GATE" ip link set gu0 down', fault)
        self.assertIn('UNDERLAY_LINK_DOWN=1', fault)
        self.assertIn('ns "$APP2" python3 "$REPO_ROOT/scripts/remote-lan-lease-soak.py" denied', fault)
        self.assertIn('ns "$GATE" ip link set gu0 up', fault)
        self.assertIn('UNDERLAY_LINK_DOWN=0', fault)
        self.assertIn('client --duration 3', fault)
        self.assertNotIn('gate_source_policy', fault)
        self.assertNotIn('source_expiry', fault)
        self.assertIn('if [ "$UNDERLAY_LINK_DOWN" -eq 1 ]; then', text)
        self.assertIn('ns "$GATE" ip link set gu0 up >/dev/null 2>&1 || true', text)
        self.assertIn('Real API fault requires the long lease smoke', text)

    def test_shell_syntax_and_real_fault_semantics_are_explicit(self):
        result = subprocess.run(["bash","-n",str(SCRIPT)],
                                capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        text = SCRIPT.read_text()
        self.assertIn("docker service update --force",text)
        self.assertIn("docker service scale",text)
        self.assertIn("kill -TERM",text)
        self.assertIn("wait_proxy 200",text)
        self.assertIn("API_STOPPED=0",text)
        self.assertNotIn("kill -9",text)


if __name__ == "__main__":
    unittest.main()
