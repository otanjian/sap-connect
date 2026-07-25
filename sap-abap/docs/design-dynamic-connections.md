# Design: Dynamic SAP connections (multi-user)

## Goal

Allow BuildingAI chat to pass SAP connection parameters at runtime via `sap_connect`, with safe isolation for concurrent users.

BuildingAI code stays unchanged in phase 1. All implementation and docs live in this `sap-abap` project.

## Why not session-only state?

BuildingAI creates a new MCP HTTP client per chat turn and closes it when the stream ends. Connection state must therefore live in a **process-global Connection Registry** on the gateway, keyed by `connection_id`, not only in the short-lived MCP HTTP session.

## Architecture

```text
BuildingAI (per chat turn, new MCP HTTP session)
  └─ streamable-http ─► single Node process (src/index.mjs)
                           ├─ short-lived MCP session transports
                           ├─ process-global Connection Registry  ← survives turns
                           ├─ sap_connect / sap_disconnect / sap_whoami
                           └─ proxied adt_* (require connection_id)
```

**Important:** Do not wrap the proxy with `supergateway --stateful` (one stdio child per HTTP session). That would fork a new registry per turn and break `connection_id` reuse. This project serves Streamable HTTP **directly** so one process owns the registry.

Each `sap_connect` spawns a dedicated `erpl-adt mcp` child with the supplied host/user/client/password. Different users/conversations use different `connection_id` values and never share a child process.

## Tools

| Tool | Behavior |
|------|----------|
| `sap_connect` | Create registry entry + child; return `{ connection_id, host, port, client, user }` (never password) |
| `sap_disconnect` | Kill child; remove entry |
| `sap_whoami` | Return non-secret metadata for a `connection_id` |
| `adt_*` (proxied) | Require `connection_id`; strip it; forward to that child; serialize per connection |

## Tool catalog

BuildingAI lists MCP tools once at client init (before any `sap_connect`). The proxy therefore exposes a **static ADT tool catalog** (discovered once from `erpl-adt`, cached in `tools-catalog.json`) and injects a required `connection_id` property into each tool's input schema.

## Concurrency rules

1. **Isolation**: one `erpl-adt` process per `connection_id`.
2. **Same connection**: tool calls serialized with a per-connection mutex (stdio is not concurrent-safe).
3. **Different connections**: may run in parallel.
4. **Limits**: `MAX_CONNECTIONS` (default 20), `IDLE_TTL_MS` (default 30 min). Idle entries are disconnected automatically.
5. **Secrets**: password only in child env / registry memory; never in tool results or info logs.

## Defaults

- Gateway no longer binds a single global SAP system for all users.
- `.env` may still provide `ERPL_ADT` path and optional catalog discovery credentials; it is not a shared live connection for chat traffic.

## Out of scope (phase 2)

- BuildingAI injecting `X-Conversation-Id` headers for automatic binding
- UI / vault for secrets so passwords never enter the model context
