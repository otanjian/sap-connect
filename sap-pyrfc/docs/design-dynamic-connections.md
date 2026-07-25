# Design: Dynamic SAP PyRFC connections (multi-user)

## Goal

Match sap-abap chat UX: pass SAP credentials via `sap_connect`, use `connection_id` on subsequent tools, isolate concurrent users.

## Approach (Option B)

In-process **ConnectionRegistry** inside `sap_pyrfc_mcp`, served by FastMCP **streamable-http** on `:8200/mcp` (no stateful supergateway child per HTTP session).

```text
BuildingAI (per chat turn)
  └─ streamable-http ─► single Python process
                           ├─ short-lived MCP HTTP sessions
                           ├─ process-global Connection Registry
                           ├─ sap_connect / sap_disconnect / sap_whoami
                           └─ call_rfc / read_table / … (require connection_id)
```

## Why not supergateway --stateful?

Each BuildingAI turn opens a new MCP HTTP client. Stateful supergateway would spawn a new stdio child per turn and wipe the registry. Native FastMCP HTTP keeps one process so `connection_id` survives across turns.

## Tools

| Tool | Notes |
|------|--------|
| `sap_connect` | RFC and/or ADT params; returns `{connection_id, …}` (no password) |
| `sap_disconnect` | Drop registry entry |
| `sap_whoami` | Non-secret metadata |
| `healthcheck` | Optional `connection_id` (SDK status vs live ping) |
| `call_rfc`, `get_rfc_function_description`, `read_table`, `run_query` | Require `connection_id` |

## Limits

- `MAX_CONNECTIONS` (default 20)
- `IDLE_TTL_MS` (default 30 min)
- Per-connection lock (serialize tool calls)

## Scope

All changes under `sap-connect/sap-pyrfc/`. BuildingAI console URL stays `http://127.0.0.1:8200/mcp`.
