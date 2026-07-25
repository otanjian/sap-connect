#!/usr/bin/env bash
# Single-process Streamable HTTP MCP with shared multi-user Connection Registry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

load_dotenv() {
  local file="$1" line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    case "$line" in
      SAP_*=*|SAPNWRFC_HOME=*|SAP_BACKEND=*|MCP_HOST=*|MCP_PORT=*|MCP_PATH=*|MCP_TRANSPORT=*|\
MAX_CONNECTIONS=*|IDLE_TTL_MS=*)
        key="${line%%=*}"
        val="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        val="${val#"${val%%[![:space:]]*}"}"
        export "${key}=${val}"
        ;;
    esac
  done <"$file"
}

if [[ -f .env ]]; then
  load_dotenv .env
fi
if [[ -f .env.local-sdk ]]; then
  load_dotenv .env.local-sdk
fi

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
export no_proxy="$NO_PROXY"

if [[ -n "${SAPNWRFC_HOME:-}" && -d "${SAPNWRFC_HOME}/lib" ]]; then
  export LD_LIBRARY_PATH="${SAPNWRFC_HOME}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

pick_python() {
  if [[ -n "${PYTHON_BIN:-}" && -x "${PYTHON_BIN}" ]]; then
    echo "$PYTHON_BIN"
    return
  fi
  local candidate
  for candidate in \
    "${HOME}/.local/share/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12" \
    python3.12 \
    python3.11 \
    python3.10 \
    python3
  do
    if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        echo "$candidate"
        return
      fi
    fi
  done
  echo "Python 3.10+ is required (mcp package)." >&2
  exit 1
}

PYTHON_BIN="$(pick_python)"

VENV="${ROOT}/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "Creating Python venv with ${PYTHON_BIN} ..."
  "$PYTHON_BIN" -m venv "$VENV"
fi

# shellcheck source=/dev/null
source "${VENV}/bin/activate"

if [[ -z "${SAP_PYRFC_SKIP_INSTALL:-}" || "${SAP_PYRFC_SKIP_INSTALL}" == "0" ]]; then
  echo "Installing Python dependencies ..."
  pip install -q -U pip
  pip install -q -r requirements.txt
  if [[ -n "${SAPNWRFC_HOME:-}" ]] && ! python -c "import pyrfc" 2>/dev/null; then
    echo "PyRFC not found — run ./install-pyrfc.sh to build against NW RFC SDK."
    echo "  ADT fallback works if sap_connect includes url=https://host:44300."
  fi
else
  echo "Skipping pip install (SAP_PYRFC_SKIP_INSTALL=${SAP_PYRFC_SKIP_INSTALL})"
fi

# uvicorn comes with mcp[cli] / streamable-http path
python -c "import uvicorn" 2>/dev/null || pip install -q uvicorn

export PYTHONPATH="${ROOT}${PYTHONPATH:+:${PYTHONPATH}}"

MCP_HOST="${MCP_HOST:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-8200}"
MCP_PATH="${MCP_PATH:-/mcp}"
MCP_TRANSPORT="${MCP_TRANSPORT:-streamable-http}"
MAX_CONNECTIONS="${MAX_CONNECTIONS:-20}"
IDLE_TTL_MS="${IDLE_TTL_MS:-1800000}"
export MCP_HOST MCP_PORT MCP_PATH MCP_TRANSPORT MAX_CONNECTIONS IDLE_TTL_MS

if command -v lsof >/dev/null 2>&1; then
  busy="$(lsof -ti:"$MCP_PORT" 2>/dev/null || true)"
  if [[ -n "$busy" ]]; then
    echo "Port ${MCP_PORT} in use (pids: ${busy}). Free it or set MCP_PORT." >&2
    exit 1
  fi
fi

echo "Starting sap-pyrfc multi-user HTTP gateway"
echo "  URL:    http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}"
echo "  limits: MAX_CONNECTIONS=${MAX_CONNECTIONS} IDLE_TTL_MS=${IDLE_TTL_MS}"
echo "  flow:   sap_connect → connection_id → call_rfc/read_table/…"
echo "Register in BuildingAI: type=streamable-http, url=http://127.0.0.1:${MCP_PORT}${MCP_PATH}"

exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  python -m sap_pyrfc_mcp
