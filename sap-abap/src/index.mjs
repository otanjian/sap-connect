#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectionRegistry } from "./connection-registry.mjs";
import { spawnErplAdtClient } from "./erpl-client.mjs";
import { startHttpGateway } from "./http-gateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCatalog() {
  const path = process.env.TOOLS_CATALOG_PATH || join(root, "tools-catalog.json");
  try {
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error("catalog empty");
    }
    return catalog;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `Missing or invalid tools-catalog.json (${msg}). Run: npm run discover-tools`,
    );
    process.exit(1);
  }
}

const erplAdtPath = process.env.ERPL_ADT || "erpl-adt";
const maxConnections = Number(process.env.MAX_CONNECTIONS || 20);
const idleTtlMs = Number(process.env.IDLE_TTL_MS || 30 * 60 * 1000);
const host = process.env.MCP_HOST || "127.0.0.1";
const port = Number(process.env.MCP_PORT || 8100);
const path = process.env.MCP_PATH || "/mcp";

const catalog = loadCatalog();
const registry = new ConnectionRegistry({
  maxConnections,
  idleTtlMs,
  spawnClient: (params) => spawnErplAdtClient(params, { erplAdtPath }),
});

await startHttpGateway({ host, port, path, registry, catalog });

const sweepMs = Math.min(Math.max(idleTtlMs / 3, 30_000), 120_000);
const timer = setInterval(() => {
  registry.sweepIdle().catch(() => {});
}, sweepMs);
timer.unref?.();

console.error(
  `catalog=${catalog.length} tools, max=${maxConnections}, idleTtlMs=${idleTtlMs}`,
);
