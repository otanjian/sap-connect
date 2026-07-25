import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Spawn an erpl-adt MCP child bound to the given SAP credentials.
 * @param {import('./connection-registry.mjs').SapConnectParams} params
 * @param {{ erplAdtPath: string }} options
 */
export async function spawnErplAdtClient(params, options) {
  const port = Number(params.port ?? 44300);
  const timeout = Number(params.timeout ?? 60);
  const args = [
    "mcp",
    "--host",
    String(params.host),
    "--port",
    String(port),
    "--user",
    String(params.user),
    "--client",
    String(params.client),
    "--timeout",
    String(timeout),
    "--password-env",
    "SAP_PASSWORD",
  ];
  if (params.https !== false) args.push("--https");
  if (params.insecure !== false) args.push("--insecure");

  const env = {
    ...getDefaultEnvironment(),
    SAP_PASSWORD: String(params.password),
    DATAZOO_DISABLE_TELEMETRY: "1",
  };

  const transport = new StdioClientTransport({
    command: options.erplAdtPath,
    args,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "sap-session-proxy-child", version: "0.1.0" });
  await client.connect(transport);

  return {
    async listTools() {
      return client.listTools();
    },
    async callTool(name, toolArgs) {
      return client.callTool({ name, arguments: toolArgs ?? {} });
    },
    async close() {
      await client.close();
    },
  };
}
