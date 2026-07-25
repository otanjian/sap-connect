#!/usr/bin/env python3
"""Unit tests for ConnectionRegistry (no SAP required)."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sap_pyrfc_mcp.config import AdtConnectionConfig, SapConnectionConfig  # noqa: E402
from sap_pyrfc_mcp.registry import ConnectionRegistry  # noqa: E402


def _rfc(user: str = "A") -> SapConnectionConfig:
    return SapConnectionConfig(
        ashost="host.example",
        sysnr="00",
        client="200",
        user=user,
        password="secret",
        lang="EN",
        saprouter="",
        mshost="",
        msserv="",
        group="",
        r3name="",
    )


class RegistryTests(unittest.TestCase):
    def test_isolates_connections_and_hides_password(self) -> None:
        reg = ConnectionRegistry(max_connections=10, idle_ttl_ms=60_000)
        a = reg.connect(rfc=_rfc("USER_A"), adt=None, backend="pyrfc")
        b = reg.connect(rfc=_rfc("USER_B"), adt=None, backend="pyrfc")
        self.assertNotEqual(a["connection_id"], b["connection_id"])
        self.assertEqual(a["rfc"]["user"], "USER_A")
        self.assertNotIn("password", str(a))
        self.assertNotIn("secret", str(a))

    def test_max_connections(self) -> None:
        reg = ConnectionRegistry(max_connections=1, idle_ttl_ms=60_000)
        reg.connect(rfc=_rfc(), adt=None, backend="auto")
        with self.assertRaisesRegex(RuntimeError, "Max connections"):
            reg.connect(rfc=_rfc("B"), adt=None, backend="auto")

    def test_serializes_same_connection(self) -> None:
        reg = ConnectionRegistry(max_connections=10, idle_ttl_ms=60_000)
        info = reg.connect(rfc=_rfc(), adt=None, backend="auto")
        order: list[str] = []

        def work(label: str) -> str:
            def _fn(_entry):
                order.append(f"{label}-start")
                order.append(f"{label}-end")
                return label

            return reg.call_with(info["connection_id"], _fn)

        t1 = threading.Thread(target=lambda: work("a"))
        t2 = threading.Thread(target=lambda: work("b"))
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        # Nested start/end pairs must not interleave for a single lock.
        self.assertIn(order, (["a-start", "a-end", "b-start", "b-end"], ["b-start", "b-end", "a-start", "a-end"]))

    def test_disconnect_and_sweep(self) -> None:
        now = {"t": 1000.0}
        reg = ConnectionRegistry(max_connections=10, idle_ttl_ms=10, now=lambda: now["t"])
        info = reg.connect(rfc=_rfc(), adt=None, backend="auto")
        reg.disconnect(info["connection_id"])
        with self.assertRaisesRegex(RuntimeError, "Unknown connection"):
            reg.whoami(info["connection_id"])

        info2 = reg.connect(rfc=_rfc(), adt=None, backend="auto")
        now["t"] = 1020.0
        reg.sweep_idle()
        with self.assertRaisesRegex(RuntimeError, "Unknown connection"):
            reg.whoami(info2["connection_id"])

    def test_adt_public_info(self) -> None:
        reg = ConnectionRegistry(max_connections=5, idle_ttl_ms=60_000)
        adt = AdtConnectionConfig(
            url="https://sap.example:44300",
            user="U",
            password="secret",
            client="300",
            language="EN",
            session_type="stateless",
            tls_verify=False,
            timeout=60,
        )
        info = reg.connect(rfc=None, adt=adt, backend="adt")
        self.assertEqual(info["adt"]["url"], "https://sap.example:44300")
        self.assertNotIn("secret", str(info))


if __name__ == "__main__":
    unittest.main()
