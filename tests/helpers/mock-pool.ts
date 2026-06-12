import type { ConnectionConfig } from "../../src/config/types.js";
import {
  DEFAULT_CONNECTION_NAME,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "../../src/config/types.js";
import type { ToolContext } from "../../src/lib/context.js";

export interface RecordedQuery {
  sql: string;
  values?: unknown[];
  timeout?: number;
}

/**
 * Test double for mysql2's pool. Records every query and returns a queued
 * response. Used to test tool handlers without touching a real MySQL.
 */
export class MockPool {
  readonly queries: RecordedQuery[] = [];
  private responses: unknown[] = [];

  /** Queue the next result (driver-style: [rows, fields] tuple). */
  pushResponse(rows: unknown): void {
    this.responses.push([rows, []]);
  }

  async query(arg: string | { sql: string; values?: unknown[]; timeout?: number }): Promise<unknown> {
    const record: RecordedQuery =
      typeof arg === "string" ? { sql: arg } : { sql: arg.sql, values: arg.values, timeout: arg.timeout };
    this.queries.push(record);
    if (this.responses.length === 0) {
      return [[], []];
    }
    return this.responses.shift();
  }
}

/**
 * Test double for our PoolManager. Returns a shared MockPool for every
 * configured connection so tests can inspect what got sent.
 */
export class MockPoolManager {
  readonly pool = new MockPool();
  private readonly configs: Map<string, ConnectionConfig>;

  constructor(connections: ConnectionConfig[]) {
    this.configs = new Map(connections.map((c) => [c.connectionName, c]));
  }

  hasConnection(name: string): boolean {
    return this.configs.has(name);
  }

  listConnectionNames(): string[] {
    return [...this.configs.keys()];
  }

  getConfig(name: string): ConnectionConfig {
    const config = this.configs.get(name);
    if (!config) throw new Error(`Unknown connection "${name}"`);
    return config;
  }

  getPool() {
    return this.pool;
  }

  async ping(): Promise<void> {
    // no-op for tests
  }

  async closeAll(): Promise<void> {
    // no-op for tests
  }
}

export interface BuildContextOptions {
  connections?: ConnectionConfig[];
  defaultConnection?: string;
  defaultQueryLimit?: number;
  defaultQueryTimeoutMs?: number;
  defaultMaxResponseBytes?: number;
}

const DEFAULT_CONNECTIONS: ConnectionConfig[] = [
  {
    connectionName: DEFAULT_CONNECTION_NAME,
    host: "127.0.0.1",
    user: "root",
    password: "test",
    database: "test_db",
  },
];

export interface TestContext extends ToolContext {
  pools: MockPoolManager;
}

export function buildTestContext(opts: BuildContextOptions = {}): TestContext {
  const connections = opts.connections ?? DEFAULT_CONNECTIONS;
  const pools = new MockPoolManager(connections);
  return {
    config: { connections },
    pools: pools as unknown as ToolContext["pools"],
    defaultConnection:
      opts.defaultConnection ?? connections[0]?.connectionName ?? DEFAULT_CONNECTION_NAME,
    defaultQueryLimit: opts.defaultQueryLimit ?? DEFAULT_QUERY_LIMIT,
    defaultQueryTimeoutMs: opts.defaultQueryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    defaultMaxResponseBytes:
      opts.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  } as TestContext;
}
