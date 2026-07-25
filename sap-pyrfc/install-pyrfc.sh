#!/usr/bin/env bash
# Build and install PyRFC against SAPNWRFC_HOME with legacy SDK auto-patch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DEV_SIDECAR_HTTP_PROXY="${DEV_SIDECAR_HTTP_PROXY:-${DS_HTTP_PROXY:-http://127.0.0.1:31180}}"
DEV_SIDECAR_HTTPS_PROXY="${DEV_SIDECAR_HTTPS_PROXY:-${DS_HTTPS_PROXY:-http://127.0.0.1:31181}}"
PYRFC_GIT="${PYRFC_GIT:-https://github.com/SAP/PyRFC.git}"
PYRFC_REF="${PYRFC_REF:-}"
BUILD_DIR="${ROOT}/.build/pyrfc-src"

load_env_var() {
  local key="$1" file="$2" line
  line="$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -1 || true)"
  [[ -z "$line" ]] && return 0
  printf '%s' "${line#*=}"
}

if [[ -f .env.local-sdk ]]; then
  SAPNWRFC_HOME="${SAPNWRFC_HOME:-$(load_env_var SAPNWRFC_HOME .env.local-sdk)}"
fi
if [[ -f .env ]]; then
  SAPNWRFC_HOME="${SAPNWRFC_HOME:-$(load_env_var SAPNWRFC_HOME .env)}"
fi

if [[ -z "${SAPNWRFC_HOME:-}" || ! -d "${SAPNWRFC_HOME}/lib" ]]; then
  echo "SAPNWRFC_HOME is not set. Run ./install-nwrfcsdk.sh first." >&2
  exit 1
fi

export SAPNWRFC_HOME
export LD_LIBRARY_PATH="${SAPNWRFC_HOME}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

sdk_tier="modern"
if [[ ! -f "${SAPNWRFC_HOME}/lib/libsapcrypto.so" ]] && ! grep -q RfcLoadCryptoLibrary "${SAPNWRFC_HOME}/include/sapnwrfc.h" 2>/dev/null; then
  sdk_tier="legacy"
fi
PYRFC_REF="${PYRFC_REF:-$([ "$sdk_tier" = "legacy" ] && echo v3.3.1 || echo v3.3.1)}"

VENV="${ROOT}/.venv"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
# shellcheck source=/dev/null
source "${VENV}/bin/activate"

pip install -q -U pip setuptools wheel cython

git_with_proxy() {
  if curl -sS --max-time 2 -x "$DEV_SIDECAR_HTTPS_PROXY" -o /dev/null https://github.com 2>/dev/null; then
    echo "Using DevSidecar proxy: ${DEV_SIDECAR_HTTPS_PROXY}" >&2
    git -c http.proxy="$DEV_SIDECAR_HTTP_PROXY" -c https.proxy="$DEV_SIDECAR_HTTPS_PROXY" "$@"
  else
    git -c http.proxy= -c https.proxy= "$@"
  fi
}

rm -rf "$BUILD_DIR"
mkdir -p "$(dirname "$BUILD_DIR")"
echo "Cloning PyRFC ${PYRFC_REF} ..."
git_with_proxy clone --depth 1 --branch "$PYRFC_REF" "$PYRFC_GIT" "$BUILD_DIR"

if [[ "$sdk_tier" == "legacy" ]]; then
  echo "Applying legacy SDK patch (no libsapcrypto) ..."
  python3 "${ROOT}/scripts/patch-pyrfc-legacy-sdk.py" "$BUILD_DIR"
fi

if curl -sS --max-time 2 -x "$DEV_SIDECAR_HTTPS_PROXY" -o /dev/null https://github.com 2>/dev/null; then
  export https_proxy="$DEV_SIDECAR_HTTPS_PROXY"
  export http_proxy="$DEV_SIDECAR_HTTP_PROXY"
fi

echo "Building PyRFC ${PYRFC_REF} (SDK tier: ${sdk_tier}) ..."
pip install "$BUILD_DIR"

python - <<'PY'
from sap_pyrfc_mcp.sdk_probe import probe_sdk
from pyrfc import Connection
import pyrfc

print("PyRFC installed:", getattr(pyrfc, "__version__", "unknown"))
print("SDK:", probe_sdk())
print("Connection class OK:", Connection)
PY
