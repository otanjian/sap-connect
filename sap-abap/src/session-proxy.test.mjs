import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ConnectionRegistry } from "./connection-registry.mjs";
import { createSessionProxyServer } from "./session-proxy.mjs";

describe("session-proxy multi-user", () => {
  it("isolates two sap_connect sessions and requires connection_id on adt tools", async () => {
    const registry = new ConnectionRegistry({
      maxConnections: 10,
      idleTtlMs: 60_000,
      spawnClient: async (params) => ({
        async listTools() {
          return { tools: [] };
        },
        async callTool(name, args) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ user: params.user, name, args }),
              },
            ],
          };
        },
        async close() {},
      }),
    });

    const server = createSessionProxyServer({
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

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["adt_search", "sap_connect", "sap_disconnect", "sap_whoami"]);

    const a = await client.callTool({
      name: "sap_connect",
      arguments: {
        host: "a.example",
        user: "USER_A",
        password: "secret-a",
        client: "200",
      },
    });
    const b = await client.callTool({
      name: "sap_connect",
      arguments: {
        host: "b.example",
        user: "USER_B",
        password: "secret-b",
        client: "100",
      },
    });

    const aInfo = JSON.parse(a.content[0].text);
    const bInfo = JSON.parse(b.content[0].text);
    assert.notEqual(aInfo.connection_id, bInfo.connection_id);
    assert.equal(JSON.stringify(a).includes("secret"), false);

    const missing = await client.callTool({
      name: "adt_search",
      arguments: { query: "ZCL" },
    });
    assert.equal(missing.isError, true);

    const ra = await client.callTool({
      name: "adt_search",
      arguments: { connection_id: aInfo.connection_id, query: "ZA" },
    });
    const rb = await client.callTool({
      name: "adt_search",
      arguments: { connection_id: bInfo.connection_id, query: "ZB" },
    });

    assert.match(ra.content[0].text, /USER_A/);
    assert.match(rb.content[0].text, /USER_B/);

    await client.close();
    await server.close();
  });
});
