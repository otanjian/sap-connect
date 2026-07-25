"""Detect SAP NW RFC SDK capabilities for PyRFC build/runtime."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from sap_pyrfc_mcp.config import sdk_home


def _sdk_lib_dir(home: str) -> Path:
    return Path(home) / "lib"


def _sdk_include_dir(home: str) -> Path:
    return Path(home) / "include"


def probe_sdk(home: str | None = None) -> dict[str, Any]:
    root = (home or sdk_home()).strip()
    if not root:
        return {
            "present": False,
            "home": None,
            "tier": "missing",
            "has_sapcrypto": False,
            "has_crypto_api": False,
            "libraries": [],
            "pyrfc_recommendation": "Install SDK: ./install-nwrfcsdk.sh --from-github",
        }

    lib_dir = _sdk_lib_dir(root)
    include_dir = _sdk_include_dir(root)
    libs = sorted(p.name for p in lib_dir.glob("*.so*")) if lib_dir.is_dir() else []

    header = include_dir / "sapnwrfc.h"
    has_crypto_api = False
    if header.is_file():
        content = header.read_text(encoding="utf-8", errors="ignore")
        has_crypto_api = "RfcLoadCryptoLibrary" in content

    has_sapcrypto = any("sapcrypto" in name for name in libs)

    if has_crypto_api and has_sapcrypto:
        tier = "modern"
        recommendation = "Use PyRFC v3.3.1 (official SAP/PyRFC)"
    elif lib_dir.is_dir() and (lib_dir / "libsapnwrfc.so").exists():
        tier = "legacy"
        recommendation = (
            "Legacy SDK detected (no libsapcrypto). "
            "Run ./install-pyrfc.sh — applies legacy patch automatically."
        )
    else:
        tier = "invalid"
        recommendation = "SDK layout invalid; expected lib/libsapnwrfc.so and include/sapnwrfc.h"

    return {
        "present": tier != "missing",
        "home": root,
        "tier": tier,
        "has_sapcrypto": has_sapcrypto,
        "has_crypto_api": has_crypto_api,
        "libraries": libs,
        "pyrfc_recommendation": recommendation,
    }
