"""Process-global SAP connection registry for multi-user chat sessions."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

from sap_pyrfc_mcp.config import AdtConnectionConfig, SapConnectionConfig

T = TypeVar("T")


@dataclass
class RegistryEntry:
    connection_id: str
    rfc: SapConnectionConfig | None
    adt: AdtConnectionConfig | None
    backend: str  # auto | pyrfc | adt
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def touch(self, now: float | None = None) -> None:
        self.last_used = now if now is not None else time.time()

    def public_info(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "connection_id": self.connection_id,
            "backend": self.backend,
        }
        if self.rfc:
            info["rfc"] = {
                "ashost": self.rfc.ashost,
                "sysnr": self.rfc.sysnr,
                "client": self.rfc.client,
                "user": self.rfc.user,
                "lang": self.rfc.lang,
                "saprouter": self.rfc.saprouter,
                "mshost": self.rfc.mshost,
            }
        if self.adt:
            info["adt"] = {
                "url": self.adt.url,
                "client": self.adt.client,
                "user": self.adt.user,
                "language": self.adt.language,
            }
        return info


class ConnectionRegistry:
    def __init__(
        self,
        *,
        max_connections: int = 20,
        idle_ttl_ms: int = 30 * 60 * 1000,
        now: Callable[[], float] | None = None,
    ) -> None:
        self.max_connections = max_connections
        self.idle_ttl_ms = idle_ttl_ms
        self._now = now or time.time
        self._entries: dict[str, RegistryEntry] = {}
        self._guard = threading.Lock()

    def connect(
        self,
        *,
        rfc: SapConnectionConfig | None,
        adt: AdtConnectionConfig | None,
        backend: str = "auto",
    ) -> dict[str, Any]:
        self.sweep_idle()
        with self._guard:
            if len(self._entries) >= self.max_connections:
                raise RuntimeError(
                    f"Max connections reached ({self.max_connections}). "
                    "Disconnect idle sessions or raise MAX_CONNECTIONS."
                )
            connection_id = str(uuid.uuid4())
            ts = self._now()
            entry = RegistryEntry(
                connection_id=connection_id,
                rfc=rfc,
                adt=adt,
                backend=backend or "auto",
                created_at=ts,
                last_used=ts,
            )
            self._entries[connection_id] = entry
            return entry.public_info()

    def disconnect(self, connection_id: str) -> dict[str, Any]:
        with self._guard:
            entry = self._entries.pop(connection_id, None)
        if entry is None:
            raise RuntimeError(f"Unknown connection_id: {connection_id}")
        return {"disconnected": True, "connection_id": connection_id}

    def whoami(self, connection_id: str) -> dict[str, Any]:
        entry = self.require(connection_id)
        entry.touch(self._now())
        return entry.public_info()

    def require(self, connection_id: str) -> RegistryEntry:
        with self._guard:
            entry = self._entries.get(connection_id)
        if entry is None:
            raise RuntimeError(f"Unknown connection_id: {connection_id}")
        return entry

    def call_with(self, connection_id: str, fn: Callable[[RegistryEntry], T]) -> T:
        entry = self.require(connection_id)
        with entry.lock:
            entry.touch(self._now())
            return fn(entry)

    def sweep_idle(self) -> None:
        now = self._now()
        ttl_s = self.idle_ttl_ms / 1000.0
        expired: list[str] = []
        with self._guard:
            for cid, entry in self._entries.items():
                if now - entry.last_used >= ttl_s:
                    expired.append(cid)
            for cid in expired:
                self._entries.pop(cid, None)

    def size(self) -> int:
        with self._guard:
            return len(self._entries)


# Process-global registry (shared across FastMCP HTTP sessions in one process).
_registry: ConnectionRegistry | None = None


def get_registry() -> ConnectionRegistry:
    global _registry
    if _registry is None:
        import os

        max_connections = int(os.environ.get("MAX_CONNECTIONS", "20") or "20")
        idle_ttl_ms = int(os.environ.get("IDLE_TTL_MS", str(30 * 60 * 1000)) or str(30 * 60 * 1000))
        _registry = ConnectionRegistry(max_connections=max_connections, idle_ttl_ms=idle_ttl_ms)
    return _registry


def reset_registry_for_tests() -> None:
    global _registry
    _registry = None
