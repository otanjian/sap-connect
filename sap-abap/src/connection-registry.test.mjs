import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { ConnectionRegistry } from "./connection-registry.mjs";

function makeFakeClient(label) {
  return {
    label,
    calls: [],
    async listTools() {
      return {
        tools: [{ name: "adt_search", description: "search", inputSchema: { type: "object" } }],
      };
    },
    async callTool(name, args) {
      this.calls.push({ name, args });
      return { content: [{ type: "text", text: `${label}:${name}` }] };
    },
    async close() {
      this.closed = true;
    },
  };
}

describe("ConnectionRegistry", () => {
  it("creates isolated connections with unique ids and never returns password", async () => {
    const clients = [];
    const registry = new ConnectionRegistry({
      maxConnections: 10,
      idleTtlMs: 60_000,
      spawnClient: async (params) => {
        const client = makeFakeClient(params.user);
        clients.push({ params, client });
        return client;
      },
    });

    const a = await registry.connect({
      host: "a.example",
      port: 44300,
      user: "USER_A",
      password: "secret-a",
      client: "200",
    });
    const b = await registry.connect({
      host: "b.example",
      port: 44300,
      user: "USER_B",
      password: "secret-b",
      client: "100",
    });

    assert.notEqual(a.connection_id, b.connection_id);
    assert.equal(a.user, "USER_A");
    assert.equal(b.user, "USER_B");
    assert.equal(a.host, "a.example");
    assert.equal("password" in a, false);
    assert.equal(JSON.stringify(a).includes("secret"), false);
    assert.equal(clients.length, 2);
    assert.equal(clients[0].params.password, "secret-a");
    assert.equal(clients[1].params.password, "secret-b");
  });

  it("rejects when max connections is reached", async () => {
    const registry = new ConnectionRegistry({
      maxConnections: 1,
      idleTtlMs: 60_000,
      spawnClient: async (params) => makeFakeClient(params.user),
    });

    await registry.connect({
      host: "a.example",
      port: 1,
      user: "A",
      password: "p",
      client: "200",
    });

    await assert.rejects(
      () =>
        registry.connect({
          host: "b.example",
          port: 1,
          user: "B",
          password: "p",
          client: "200",
        }),
      /max connections/i,
    );
  });

  it("routes callTool to the matching connection and serializes per connection", async () => {
    const registry = new ConnectionRegistry({
      maxConnections: 10,
      idleTtlMs: 60_000,
      spawnClient: async (params) => makeFakeClient(params.user),
    });

    const a = await registry.connect({
      host: "a.example",
      port: 1,
      user: "A",
      password: "p",
      client: "200",
    });
    const b = await registry.connect({
      host: "b.example",
      port: 1,
      user: "B",
      password: "p",
      client: "200",
    });

    const order = [];
    const slowA = registry.callTool(a.connection_id, "adt_search", { query: "1" }).then((r) => {
      order.push("a-done");
      return r;
    });
    // Interleave a microtask; B should still be able to proceed independently.
    const fastB = registry.callTool(b.connection_id, "adt_search", { query: "2" }).then((r) => {
      order.push("b-done");
      return r;
    });

    const [ra, rb] = await Promise.all([slowA, fastB]);
    assert.match(ra.content[0].text, /^A:/);
    assert.match(rb.content[0].text, /^B:/);
    assert.deepEqual(order.sort(), ["a-done", "b-done"]);
  });

  it("disconnect removes the connection and closes the client", async () => {
    let client;
    const registry = new ConnectionRegistry({
      maxConnections: 10,
      idleTtlMs: 60_000,
      spawnClient: async (params) => {
        client = makeFakeClient(params.user);
        return client;
      },
    });

    const info = await registry.connect({
      host: "a.example",
      port: 1,
      user: "A",
      password: "p",
      client: "200",
    });
    await registry.disconnect(info.connection_id);
    assert.equal(client.closed, true);
    await assert.rejects(() => registry.whoami(info.connection_id), /unknown connection/i);
  });

  it("sweeps idle connections", async () => {
    const registry = new ConnectionRegistry({
      maxConnections: 10,
      idleTtlMs: 10,
      spawnClient: async (params) => makeFakeClient(params.user),
      now: mock.fn(() => 1000),
    });

    const info = await registry.connect({
      host: "a.example",
      port: 1,
      user: "A",
      password: "p",
      client: "200",
    });

    registry.now = () => 1020;
    await registry.sweepIdle();
    await assert.rejects(() => registry.whoami(info.connection_id), /unknown connection/i);
  });
});
