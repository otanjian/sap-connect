import { randomUUID } from "node:crypto";

/**
 * Process-global registry of SAP MCP child connections.
 * Isolates concurrent users via connection_id.
 */
export class ConnectionRegistry {
  /**
   * @param {{
   *   maxConnections?: number,
   *   idleTtlMs?: number,
   *   spawnClient: (params: SapConnectParams) => Promise<SapClient>,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.maxConnections = options.maxConnections ?? 20;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.spawnClient = options.spawnClient;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, RegistryEntry>} */
    this.entries = new Map();
  }

  /**
   * @param {SapConnectParams} params
   */
  async connect(params) {
    await this.sweepIdle();
    if (this.entries.size >= this.maxConnections) {
      throw new Error(
        `Max connections reached (${this.maxConnections}). Disconnect idle sessions or raise MAX_CONNECTIONS.`,
      );
    }

    const connectionId = randomUUID();
    const client = await this.spawnClient(params);
    const entry = {
      id: connectionId,
      host: String(params.host),
      port: Number(params.port ?? 44300),
      user: String(params.user),
      client: String(params.client),
      https: Boolean(params.https ?? true),
      insecure: Boolean(params.insecure ?? true),
      mcpClient: client,
      lastUsed: this.now(),
      queue: Promise.resolve(),
    };
    this.entries.set(connectionId, entry);
    return this.publicInfo(entry);
  }

  /**
   * @param {string} connectionId
   */
  async disconnect(connectionId) {
    const entry = this.require(connectionId);
    this.entries.delete(connectionId);
    try {
      await entry.mcpClient.close();
    } catch {
      // ignore close errors
    }
    return { disconnected: true, connection_id: connectionId };
  }

  /**
   * @param {string} connectionId
   */
  async whoami(connectionId) {
    const entry = this.require(connectionId);
    entry.lastUsed = this.now();
    return this.publicInfo(entry);
  }

  /**
   * Serialize tool calls per connection; different connections may run in parallel.
   * @param {string} connectionId
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  callTool(connectionId, name, args) {
    const entry = this.require(connectionId);
    const run = async () => {
      entry.lastUsed = this.now();
      return entry.mcpClient.callTool(name, args);
    };
    const result = entry.queue.then(run, run);
    entry.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async sweepIdle() {
    const now = this.now();
    const expired = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsed >= this.idleTtlMs) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      await this.disconnect(id);
    }
  }

  size() {
    return this.entries.size;
  }

  /**
   * @param {string} connectionId
   */
  require(connectionId) {
    const entry = this.entries.get(connectionId);
    if (!entry) {
      throw new Error(`Unknown connection_id: ${connectionId}`);
    }
    return entry;
  }

  /**
   * @param {RegistryEntry} entry
   */
  publicInfo(entry) {
    return {
      connection_id: entry.id,
      host: entry.host,
      port: entry.port,
      client: entry.client,
      user: entry.user,
      https: entry.https,
      insecure: entry.insecure,
    };
  }
}

/**
 * @typedef {{
 *   host: string,
 *   port?: number,
 *   user: string,
 *   password: string,
 *   client: string,
 *   https?: boolean,
 *   insecure?: boolean,
 *   timeout?: number,
 * }} SapConnectParams
 *
 * @typedef {{
 *   listTools: () => Promise<{ tools: unknown[] }>,
 *   callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
 *   close: () => Promise<void>,
 * }} SapClient
 *
 * @typedef {{
 *   id: string,
 *   host: string,
 *   port: number,
 *   user: string,
 *   client: string,
 *   https: boolean,
 *   insecure: boolean,
 *   mcpClient: SapClient,
 *   lastUsed: number,
 *   queue: Promise<unknown>,
 * }} RegistryEntry
 */
