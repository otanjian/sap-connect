import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { injectConnectionId, stripConnectionId } from "./tool-schema.mjs";

describe("tool-schema", () => {
  it("injects required connection_id into input schema", () => {
    const tool = {
      name: "adt_search",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };

    const out = injectConnectionId(tool);
    assert.equal(out.inputSchema.properties.connection_id.type, "string");
    assert.ok(out.inputSchema.required.includes("connection_id"));
    assert.ok(out.inputSchema.required.includes("query"));
    assert.equal(out.name, "adt_search");
  });

  it("strips connection_id from args", () => {
    const { connectionId, args } = stripConnectionId({
      connection_id: "abc",
      query: "ZCL",
    });
    assert.equal(connectionId, "abc");
    assert.deepEqual(args, { query: "ZCL" });
  });
});
