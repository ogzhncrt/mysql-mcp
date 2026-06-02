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
  queryTimeoutMs?: number;
  ssl?: SslConfig;
}

export interface AppConfig {
  defaults?: {
    connection?: string;
    queryLimit?: number;
    queryTimeoutMs?: number;
  };
  connections: ConnectionConfig[];
}

export const DEFAULT_PORT = 3306;
export const DEFAULT_CONNECTION_LIMIT = 5;
export const DEFAULT_QUERY_LIMIT = 100;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECTION_NAME = "default";
export const MAX_QUERY_LIMIT = 10_000;
