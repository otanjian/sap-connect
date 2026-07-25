/**
 * @param {{ name: string, description?: string, inputSchema?: Record<string, unknown> }} tool
 */
export function injectConnectionId(tool) {
  const base =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? structuredClone(tool.inputSchema)
      : { type: "object", properties: {} };

  if (!base.properties || typeof base.properties !== "object") {
    base.properties = {};
  }
  base.type = "object";
  base.properties.connection_id = {
    type: "string",
    description:
      "Connection id returned by sap_connect. Required for multi-user isolation.",
  };
  const required = Array.isArray(base.required) ? [...base.required] : [];
  if (!required.includes("connection_id")) {
    required.unshift("connection_id");
  }
  base.required = required;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: base,
  };
}

/**
 * @param {Record<string, unknown>} input
 */
export function stripConnectionId(input) {
  const { connection_id: connectionId, ...args } = input ?? {};
  if (!connectionId || typeof connectionId !== "string") {
    throw new Error("connection_id is required. Call sap_connect first.");
  }
  return { connectionId, args };
}
