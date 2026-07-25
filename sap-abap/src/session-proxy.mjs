import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { injectConnectionId, stripConnectionId } from "./tool-schema.mjs";

const SAP_CONNECT_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "string", description: "SAP hostname" },
    port: { type: "number", description: "SAP port (default 44300)" },
    user: { type: "string", description: "SAP username" },
    password: { type: "string", description: "SAP password (not echoed in results)" },
    client: { type: "string", description: "SAP client, e.g. 200" },
    https: { type: "boolean", description: "Use HTTPS (default true)" },
    insecure: { type: "boolean", description: "Skip TLS verify (default true)" },
    timeout: { type: "number", description: "Request timeout seconds (default 60)" },
  },
  required: ["host", "user", "password", "client"],
};

const CONNECTION_ID_SCHEMA = {
  type: "object",
  properties: {
    connection_id: {
      type: "string",
      description: "Connection id from sap_connect",
    },
  },
  required: ["connection_id"],
};

/**
 * @param {{
 *   registry: import('./connection-registry.mjs').ConnectionRegistry,
 *   catalog: Array<{ name: string, description?: string, inputSchema?: Record<string, unknown> }>,
 * }} options
 */
export function createSessionProxyServer(options) {
  const { registry, catalog } = options;

  const server = new Server(
    { name: "sap-abap", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const proxiedTools = catalog.map((tool) => injectConnectionId(tool));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "sap_connect",
        description:
          "Connect to a SAP system for this chat. Returns connection_id. Pass connection_id to all subsequent adt_* tools. Supports concurrent users via isolated connections.",
        inputSchema: SAP_CONNECT_SCHEMA,
      },
      {
        name: "sap_disconnect",
        description: "Disconnect and destroy a SAP connection_id.",
        inputSchema: CONNECTION_ID_SCHEMA,
      },
      {
        name: "sap_whoami",
        description: "Show non-secret connection metadata for a connection_id.",
        inputSchema: CONNECTION_ID_SCHEMA,
      },
      ...proxiedTools,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});

    try {
      if (name === "sap_connect") {
        const info = await registry.connect({
          host: String(args.host ?? ""),
          port: args.port !== undefined ? Number(args.port) : undefined,
          user: String(args.user ?? ""),
          password: String(args.password ?? ""),
          client: String(args.client ?? ""),
          https: args.https !== undefined ? Boolean(args.https) : undefined,
          insecure: args.insecure !== undefined ? Boolean(args.insecure) : undefined,
          timeout: args.timeout !== undefined ? Number(args.timeout) : undefined,
        });
        return textResult(JSON.stringify(info, null, 2));
      }

      if (name === "sap_disconnect") {
        const connectionId = String(args.connection_id ?? "");
        const info = await registry.disconnect(connectionId);
        return textResult(JSON.stringify(info, null, 2));
      }

      if (name === "sap_whoami") {
        const connectionId = String(args.connection_id ?? "");
        const info = await registry.whoami(connectionId);
        return textResult(JSON.stringify(info, null, 2));
      }

      const { connectionId, args: forwarded } = stripConnectionId(args);
      const result = await registry.callTool(connectionId, name, forwarded);
      return /** @type {any} */ (result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  return server;
}

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}
