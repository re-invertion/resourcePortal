#!/usr/bin/env python3
"""Fast, disposable UDP correctness test; does not replace the real 443s smoke."""
import contextlib
import importlib.util
import io
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "scripts/remote-lan-lease-soak.py"
spec = importlib.util.spec_from_file_location("remote_lan_lease_soak", MODULE)
soak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(soak)


class RemoteLanLeaseEventTests(unittest.TestCase):
    def test_bidirectional_motion_and_click_acknowledgments(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        server.bind(("127.0.0.1", 0))
        server.settimeout(4)
        address = server.getsockname()
        seen = []

        def echo():
            try:
                for _ in range(90):
                    payload, client = server.recvfrom(2048)
                    seen.append(payload)
                    server.sendto(b"ACK:" + payload, client)
            finally:
                server.close()

        thread = threading.Thread(target=echo, daemon=True)
        thread.start()
        with patch.object(soak, "CLIENT_IP", "127.0.0.1"), \
             patch.object(soak, "TARGET", address):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                soak.client(1)
            self.assertIn('"acknowledged": 90', output.getvalue())
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(seen), 90)
        self.assertEqual(sum(x.startswith(b"motion:") for x in seen), 45)
        self.assertEqual(sum(x.startswith(b"click:") for x in seen), 45)

    def test_expired_source_must_not_return_an_ack(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as ephemeral:
            ephemeral.bind(("127.0.0.1", 0))
            unused_port = ephemeral.getsockname()[1]
        with patch.object(soak, "CLIENT_IP", "127.0.0.1"), \
             patch.object(soak, "TARGET", ("127.0.0.1", unused_port)):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                soak.denied()
            self.assertIn("expired Gate source denied", output.getvalue())


if __name__ == "__main__":
    unittest.main()
