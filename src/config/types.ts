export interface ConnectionConfig {
  connectionName: string;
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  readOnly?: boolean;
  connectionLimit?: number;
}

export interface AppConfig {
  defaults?: {
    connection?: string;
    queryLimit?: number;
  };
  connections: ConnectionConfig[];
}

export const DEFAULT_PORT = 3306;
export const DEFAULT_CONNECTION_LIMIT = 5;
export const DEFAULT_QUERY_LIMIT = 100;
export const DEFAULT_CONNECTION_NAME = "default";
