export type SslPreset = "Amazon RDS";

export interface SslOptions {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  minVersion?: string;
  servername?: string;
}

export type SslConfig = boolean | SslPreset | SslOptions;

export interface ConnectionConfig {
  connectionName: string;
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  readOnly?: boolean;
  connectionLimit?: number;
  /**
   * Maximum number of queued connection requests once `connectionLimit` is
   * saturated. 0 means unbounded. Defaults to a bounded value so a burst of
   * calls fails fast instead of piling up without limit.
   */
  queueLimit?: number;
  queryTimeoutMs?: number;
  ssl?: SslConfig;
  /**
   * When true, the driver allows multiple statements per query separated
   * by `;`. Off by default because it lets a single injection vector turn
   * one query into many. Enable only when you trust the calling client.
   */
  multipleStatements?: boolean;
}

export interface AppConfig {
  defaults?: {
    connection?: string;
    queryLimit?: number;
    queryTimeoutMs?: number;
    maxResponseBytes?: number;
  };
  connections: ConnectionConfig[];
}

export const DEFAULT_PORT = 3306;
export const DEFAULT_CONNECTION_LIMIT = 5;
export const DEFAULT_QUEUE_LIMIT = 20;
export const DEFAULT_QUERY_LIMIT = 100;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECTION_NAME = "default";
export const MAX_QUERY_LIMIT = 10_000;
/** Upper bound on any per-query timeout, so a single call can't pin a
 * pooled connection open indefinitely. One hour. */
export const MAX_QUERY_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
