import mysql, { type Pool } from "mysql2/promise";

import type { ConnectionConfig } from "../config/types.js";
import { DEFAULT_CONNECTION_LIMIT, DEFAULT_PORT } from "../config/types.js";

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
    const pool = mysql.createPool({
      host: config.host,
      port: config.port ?? DEFAULT_PORT,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: config.connectionLimit ?? DEFAULT_CONNECTION_LIMIT,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    this.pools.set(name, pool);
    return pool;
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
