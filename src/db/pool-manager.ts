import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

import type { ConnectionConfig } from "../config/types.js";
import {
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_PORT,
  DEFAULT_QUEUE_LIMIT,
} from "../config/types.js";

export class PoolManager {
  private readonly configs: Map<string, ConnectionConfig>;
  private readonly pools = new Map<string, Pool>();

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
    if (!config) {
      throw new Error(
        `Unknown connection "${name}". Available: ${this.listConnectionNames().join(", ") || "(none)"}`,
      );
    }
    return config;
  }

  getPool(name: string): Pool {
    const existing = this.pools.get(name);
    if (existing) return existing;

    const config = this.getConfig(name);
    const options: PoolOptions = {
      host: config.host,
      port: config.port ?? DEFAULT_PORT,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: config.connectionLimit ?? DEFAULT_CONNECTION_LIMIT,
      queueLimit: config.queueLimit ?? DEFAULT_QUEUE_LIMIT,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      multipleStatements: config.multipleStatements === true,
      // BIGINTs above 2^53 would silently lose precision as JS numbers;
      // with supportBigNumbers they come back as strings only when needed.
      supportBigNumbers: true,
      // Return DATE/DATETIME/TIMESTAMP as plain strings instead of JS
      // Date objects, avoiding timezone shifts in the JSON output.
      dateStrings: true,
    };
    if (config.ssl !== undefined) {
      options.ssl = config.ssl as PoolOptions["ssl"];
    }
    const pool = mysql.createPool(options);
    this.pools.set(name, pool);
    return pool;
  }

  async ping(name: string): Promise<void> {
    const pool = this.getPool(name);
    const conn = await pool.getConnection();
    try {
      await conn.query("SELECT 1");
    } finally {
      conn.release();
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pools.entries()];
    this.pools.clear();
    for (const [name, pool] of entries) {
      try {
        await pool.end();
        process.stderr.write(`Closed pool "${name}"\n`);
      } catch (err) {
        process.stderr.write(
          `Error closing pool "${name}": ${(err as Error).message}\n`,
        );
      }
    }
  }
}
