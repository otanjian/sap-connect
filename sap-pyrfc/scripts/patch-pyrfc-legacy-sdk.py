#!/usr/bin/env python3
"""Patch SAP PyRFC sources to build against legacy NW RFC SDK without libsapcrypto."""

from __future__ import annotations

import sys
from pathlib import Path


def patch_file(path: Path, old: str, new: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        return False
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def patch_pyrfc_tree(root: Path) -> None:
    cyrfc = root / "src" / "pyrfc" / "_cyrfc.pyx"
    pxd = root / "src" / "pyrfc" / "csapnwrfc.pxd"
    init_py = root / "src" / "pyrfc" / "__init__.py"

    if not cyrfc.is_file():
        raise SystemExit(f"PyRFC source not found: {cyrfc}")

    stub = '''def set_cryptolib_path(path_name):
    """Legacy SDK stub — crypto library not available in this NW RFC SDK build."""
    raise NotImplementedError(
        "set_cryptolib_path requires libsapcrypto (NW RFC SDK 7.50+). "
        "Use a modern SDK or ADT fallback backend."
    )
'''

    text = cyrfc.read_text(encoding="utf-8")
    start = text.find("def set_cryptolib_path(path_name):")
    end = text.find("\ndef set_locale_radix", start)
    if start == -1 or end == -1:
        raise SystemExit("Could not locate set_cryptolib_path in _cyrfc.pyx")
    cyrfc.write_text(text[:start] + stub + text[end + 1 :], encoding="utf-8")

    if pxd.is_file():
        patch_file(
            pxd,
            "    RFC_RC RfcLoadCryptoLibrary (const SAP_UC *pathName, RFC_ERROR_INFO *errorInfo)\n",
            "",
        )

    if init_py.is_file():
        patch_file(init_py, "        set_cryptolib_path,\n", "")

    print(f"Patched legacy SDK compatibility in {root}")


if __name__ == "__main__":
    patch_pyrfc_tree(Path(sys.argv[1]).resolve())
