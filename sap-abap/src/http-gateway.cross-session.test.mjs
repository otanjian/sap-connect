import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ConnectionRegistry } from "./connection-registry.mjs";
import { startHttpGateway } from "./http-gateway.mjs";

describe("http-gateway cross-session registry", () => {
  /** @type {import('node:http').Server} */
  let server;
  const port = 18100 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}/mcp`;

  before(async () => {
    const registry = new ConnectionRegistry({
      maxConnections: 5,
      idleTtlMs: 60_000,
      spawnClient: async (params) => ({
        async listTools() {
          return { tools: [] };
        },
        async callTool(name, args) {
          return {
            content: [{ type: "text", text: `${params.user}:${name}:${args.query}` }],
          };
        },
        async close() {},
      }),
    });

    server = await startHttpGateway({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      registry,
      catalog: [
        {
          name: "adt_search",
          description: "search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("reuses connection_id after MCP HTTP session is closed (BuildingAI multi-turn)", async () => {
    const t1 = new StreamableHTTPClientTransport(new URL(base));
    const c1 = new Client({ name: "turn1", version: "1.0.0" });
    await c1.connect(t1);
    const connected = await c1.callTool({
      name: "sap_connect",
      arguments: {
        host: "x.example",
        user: "USER_X",
        password: "secret",
        client: "200",
      },
    });
    const info = JSON.parse(connected.content[0].text);
    await c1.close();

    const t2 = new StreamableHTTPClientTransport(new URL(base));
    const c2 = new Client({ name: "turn2", version: "1.0.0" });
    await c2.connect(t2);
    const search = await c2.callTool({
      name: "adt_search",
      arguments: { connection_id: info.connection_id, query: "ZCL" },
    });
    assert.equal(search.isError, undefined);
    assert.equal(search.content[0].text, "USER_X:adt_search:ZCL");
    await c2.close();
  });
});
