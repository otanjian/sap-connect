#!/usr/bin/env node
/**
 * Discover erpl-adt tool schemas and write tools-catalog.json.
 * Uses .env SAP_* credentials for a one-shot stdio connect.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnErplAdtClient } from "../src/erpl-client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    out[key] = val;
  }
  return out;
}

const env = { ...loadDotEnv(join(root, ".env")), ...process.env };
const erplAdtPath = env.ERPL_ADT || "erpl-adt";

const client = await spawnErplAdtClient(
  {
    host: env.SAP_HOST,
    port: Number(env.SAP_PORT || 44300),
    user: env.SAP_USER,
    password: env.SAP_PASSWORD,
    client: env.SAP_CLIENT,
    https: env.SAP_HTTPS !== "0",
    insecure: env.SAP_INSECURE !== "0",
    timeout: Number(env.SAP_TIMEOUT || 60),
  },
  { erplAdtPath },
);

try {
  const listed = await client.listTools();
  const catalog = listed.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const outPath = join(root, "tools-catalog.json");
  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${catalog.length} tools to ${outPath}`);
} finally {
  await client.close();
}
