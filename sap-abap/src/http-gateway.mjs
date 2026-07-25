import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createSessionProxyServer } from "./session-proxy.mjs";

/**
 * Single-process Streamable HTTP MCP gateway.
 * MCP HTTP sessions are short-lived; ConnectionRegistry is process-global and survives them.
 *
 * @param {{
 *   host: string,
 *   port: number,
 *   path: string,
 *   registry: import('./connection-registry.mjs').ConnectionRegistry,
 *   catalog: unknown[],
 * }} options
 */
export function startHttpGateway(options) {
  const { host, port, path, registry, catalog } = options;
  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const transports = new Map();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== path) {
        res.writeHead(404).end("Not Found");
        return;
      }

      if (req.method === "POST") {
        const body = await readJson(req);
        await handlePost(req, res, body, { transports, registry, catalog });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || typeof sessionId !== "string" || !transports.has(sessionId)) {
          res.writeHead(400).end("Invalid or missing session ID");
          return;
        }
        await transports.get(sessionId).handleRequest(req, res);
        return;
      }

      res.writeHead(405).end("Method Not Allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message },
            id: null,
          }),
        );
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      console.error(
        `sap-abap HTTP gateway listening on http://${host}:${port}${path} (shared connection registry)`,
      );
      resolve(server);
    });
  });
}

async function handlePost(req, res, body, ctx) {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && typeof sessionId === "string" && ctx.transports.has(sessionId)) {
    await ctx.transports.get(sessionId).handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        ctx.transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) ctx.transports.delete(sid);
      // Do NOT disconnect SAP connections — they outlive MCP HTTP sessions.
    };

    const mcpServer = createSessionProxyServer({
      registry: ctx.registry,
      catalog: ctx.catalog,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    }),
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
