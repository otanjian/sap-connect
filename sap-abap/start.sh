#!/usr/bin/env bash
# Single-process Streamable HTTP MCP gateway with shared multi-user Connection Registry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .run

load_dotenv() {
  local file="$1" line key val
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    case "$line" in
      ERPL_ADT=*|MAX_CONNECTIONS=*|IDLE_TTL_MS=*|TOOLS_CATALOG_PATH=*|\
MCP_HOST=*|MCP_PORT=*|MCP_PATH=*|\
SAP_HOST=*|SAP_PORT=*|SAP_USER=*|SAP_PASSWORD=*|SAP_CLIENT=*|SAP_HTTPS=*|SAP_INSECURE=*|SAP_TIMEOUT=*|\
DATAZOO_DISABLE_TELEMETRY=*)
        key="${line%%=*}"
        val="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        val="${val#"${val%%[![:space:]]*}"}"
        export "${key}=${val}"
        ;;
    esac
  done <"$file"
}

load_dotenv .env

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
  nvm use 22 >/dev/null 2>&1 || true
fi

ERPL_ADT="${ERPL_ADT:-$(command -v erpl-adt || true)}"
if [[ -z "$ERPL_ADT" || ! -x "$ERPL_ADT" ]]; then
  echo "erpl-adt not found. Install: uv tool install erpl-adt" >&2
  exit 1
fi
export ERPL_ADT

if [[ ! -f tools-catalog.json ]]; then
  echo "tools-catalog.json missing — discovering from erpl-adt (needs SAP_* in .env)..."
  if [[ -z "${SAP_HOST:-}" || -z "${SAP_USER:-}" || -z "${SAP_PASSWORD:-}" || -z "${SAP_CLIENT:-}" ]]; then
    echo "Set SAP_* in .env, then: npm run discover-tools" >&2
    exit 1
  fi
  npm run discover-tools
fi

MCP_HOST="${MCP_HOST:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-8100}"
MCP_PATH="${MCP_PATH:-/mcp}"
MAX_CONNECTIONS="${MAX_CONNECTIONS:-20}"
IDLE_TTL_MS="${IDLE_TTL_MS:-1800000}"
export MCP_HOST MCP_PORT MCP_PATH MAX_CONNECTIONS IDLE_TTL_MS
export DATAZOO_DISABLE_TELEMETRY="${DATAZOO_DISABLE_TELEMETRY:-1}"

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
export no_proxy="$NO_PROXY"

if command -v lsof >/dev/null 2>&1; then
  busy="$(lsof -ti:"$MCP_PORT" 2>/dev/null || true)"
  if [[ -n "$busy" ]]; then
    echo "Port ${MCP_PORT} in use (pids: ${busy}). Free it or set MCP_PORT." >&2
    exit 1
  fi
fi

echo "Starting sap-abap multi-user HTTP gateway"
echo "  URL:    http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}"
echo "  limits: MAX_CONNECTIONS=${MAX_CONNECTIONS} IDLE_TTL_MS=${IDLE_TTL_MS}"
echo "  flow:   sap_connect → connection_id → adt_* (isolated per user)"
echo "Register in BuildingAI: type=streamable-http, url=http://127.0.0.1:${MCP_PORT}${MCP_PATH}"

exec node "$ROOT/src/index.mjs"
