# sap-abap — Multi-user SAP ADT MCP for BuildingAI / Cursor

Wraps [`erpl-adt`](https://pypi.org/project/erpl-adt/) with a **session proxy** so chat can pass SAP connection parameters dynamically.

Design details: [`docs/design-dynamic-connections.md`](docs/design-dynamic-connections.md)

## Why a proxy?

- BuildingAI opens a new MCP HTTP client **per chat turn**
- Multiple users must not share one SAP login
- Solution: `sap_connect` returns a `connection_id`; each id owns an isolated `erpl-adt` child process in a process-global registry

## Prerequisites

```bash
uv tool install erpl-adt
cd /Users/jiantan/ai_assistant/sap-abap
npm install
cp .env.example .env   # SAP_* needed once for tool catalog discovery
npm run discover-tools
chmod +x start.sh
```

## Start for BuildingAI

```bash
./start.sh
# or detached:
# mkdir -p .run && setsid ./start.sh > .run/mcp.log 2>&1 < /dev/null & echo $! > .run/mcp.pid
```

Runs a **single Node process** (shared Connection Registry). Do not put this behind `supergateway --stateful`.

Register in BuildingAI console:

| Field | Value |
|-------|--------|
| Name | `sap-abap` |
| Type | Streamable HTTP |
| URL | `http://127.0.0.1:8100/mcp` |

Keep BuildingAI `.env` `START_SAP_MCP=false` so yan252 does not steal `:8100`.

## Chat usage (multi-user)

```text
1) sap_connect(host, user, password, client, …)
   → { connection_id, host, client, user }   # password never echoed

2) adt_search({ connection_id, … })
   adt_read_source({ connection_id, … })
   …

3) sap_disconnect({ connection_id })
```

Concurrent users each call `sap_connect` and keep their own `connection_id` (from tool results in that conversation’s history).

## Limits

| Env | Default | Meaning |
|-----|---------|---------|
| `MAX_CONNECTIONS` | 20 | Max live SAP children |
| `IDLE_TTL_MS` | 1800000 (30m) | Idle connection reaped |

Same `connection_id`: tool calls are serialized. Different ids: parallel.

## Cursor (stdio, single developer)

`.cursor/mcp.json` can still launch `erpl-adt mcp` directly with fixed env for local IDE use. BuildingAI should use this HTTP gateway.

## Develop

```bash
npm test
npm run discover-tools   # refresh tools-catalog.json after erpl-adt upgrades
```
