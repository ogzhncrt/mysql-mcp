import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import { AppConfigSchema } from "./schema.js";
import type { AppConfig, ConnectionConfig, SslConfig } from "./types.js";
import { DEFAULT_CONNECTION_NAME } from "./types.js";

const PLACEHOLDER_TOKEN = "your-";
const PLACEHOLDER_FIELDS: Array<keyof Pick<
  ConnectionConfig,
  "host" | "user" | "password" | "database"
>> = ["host", "user", "password", "database"];

export interface LoadConfigOptions {
  cliConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Override `os.homedir()` for the user-config auto-discovery path.
   * Tests pass this to keep loader behavior independent of the host's
   * `~/.config/mcp-server-mysql/config.json` file.
   */
  homedir?: string;
}

export interface LoadConfigResult {
  config: AppConfig;
  source:
    | { kind: "file"; path: string }
    | { kind: "env" };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function resolveConfigPath(
  options: LoadConfigOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.homedir ?? homedir();

  const candidates: Array<string | undefined> = [
    options.cliConfigPath,
    env.MCP_MYSQL_CONFIG,
    join(cwd, "mcp-mysql.config.json"),
    join(home, ".config", "mcp-server-mysql", "config.json"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const abs = resolve(candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const env = options.env ?? process.env;
  const filePath = resolveConfigPath(options);

  if (filePath) {
    const raw = readFromFile(filePath);
    const validated = validate(raw, `config file ${filePath}`);
    const filtered = filterPlaceholders(validated);
    if (filtered.connections.length === 0) {
      throw new ConfigError(
        buildPlaceholderError(filePath, validated.connections.length),
      );
    }
    return { config: filtered, source: { kind: "file", path: filePath } };
  }

  const fromEnv = buildConfigFromEnv(env);
  if (!fromEnv) {
    throw new ConfigError(buildNoSourceError());
  }
  const validated = validate(fromEnv, "environment variables");
  const filtered = filterPlaceholders(validated);
  if (filtered.connections.length === 0) {
    throw new ConfigError(
      buildPlaceholderError(null, validated.connections.length),
    );
  }
  return { config: filtered, source: { kind: "env" } };
}

function readFromFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file ${filePath}: ${(err as Error).message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(
      `Config file ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function validate(raw: unknown, source: string): AppConfig {
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");
    throw new ConfigError(
      `Invalid config from ${source}:\n${issues}`,
    );
  }
  return parsed.data;
}

function filterPlaceholders(config: AppConfig): AppConfig {
  const filtered = config.connections.filter((conn) =>
    PLACEHOLDER_FIELDS.every(
      (field) => !String(conn[field] ?? "").includes(PLACEHOLDER_TOKEN),
    ),
  );
  return { ...config, connections: filtered };
}

function buildConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig | null {
  const base = env.MYSQL_URL?.trim()
    ? parseMysqlUrl(env.MYSQL_URL.trim())
    : parseDiscreteEnv(env);
  if (!base) return null;

  const connectionName =
    env.MYSQL_CONNECTION_NAME?.trim() || DEFAULT_CONNECTION_NAME;
  const readOnly = parseBoolEnv(env.MYSQL_READ_ONLY);
  const ssl = parseSslEnv(env.MYSQL_SSL) ?? base.ssl;

  const queryTimeoutRaw = env.MYSQL_QUERY_TIMEOUT_MS?.trim();
  const queryTimeoutMs = queryTimeoutRaw ? Number(queryTimeoutRaw) : undefined;
  if (
    queryTimeoutMs !== undefined &&
    (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1)
  ) {
    throw new ConfigError(
      `MYSQL_QUERY_TIMEOUT_MS must be a positive integer (got "${queryTimeoutRaw}")`,
    );
  }

  return {
    defaults: { connection: connectionName },
    connections: [
      {
        connectionName,
        host: base.host,
        ...(base.port !== undefined ? { port: base.port } : {}),
        user: base.user,
        password: base.password,
        database: base.database,
        readOnly,
        ...(queryTimeoutMs !== undefined ? { queryTimeoutMs } : {}),
        ...(ssl !== undefined ? { ssl } : {}),
      },
    ],
  };
}

interface EnvConnectionBase {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssl?: SslConfig;
}

function parseDiscreteEnv(env: NodeJS.ProcessEnv): EnvConnectionBase | null {
  const host = env.MYSQL_HOST?.trim();
  const user = env.MYSQL_USER?.trim();
  const password = env.MYSQL_PASSWORD;
  const database = env.MYSQL_DATABASE?.trim();

  if (!host || !user || password == null || !database) return null;

  const portRaw = env.MYSQL_PORT?.trim();
  const port = portRaw ? Number(portRaw) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new ConfigError(
      `MYSQL_PORT must be an integer between 1 and 65535 (got "${portRaw}")`,
    );
  }

  return { host, user, password, database, port };
}

/**
 * Parses a `mysql://user:password@host:port/database` URL. User, password,
 * and database are URL-decoded so they may contain reserved characters
 * (e.g. an "@" or "/" in the password). A `?ssl=true|false|amazon-rds`
 * query parameter is honored; MYSQL_SSL still overrides it when set.
 */
function parseMysqlUrl(raw: string): EnvConnectionBase {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `MYSQL_URL is not a valid URL. Expected mysql://user:password@host:port/database`,
    );
  }

  if (url.protocol !== "mysql:" && url.protocol !== "mysqls:") {
    throw new ConfigError(
      `MYSQL_URL must use the mysql:// scheme (got "${url.protocol}//")`,
    );
  }

  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (!host || !user || !database) {
    throw new ConfigError(
      `MYSQL_URL must include host, user, and database: ` +
        `mysql://user:password@host:port/database`,
    );
  }

  let port: number | undefined;
  if (url.port) {
    port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `MYSQL_URL port must be between 1 and 65535 (got "${url.port}")`,
      );
    }
  }

  const sslParam = url.searchParams.get("ssl") ?? undefined;
  const ssl =
    url.protocol === "mysqls:" ? true : parseSslEnv(sslParam ?? undefined);

  return { host, user, password, database, port, ssl };
}

function parseSslEnv(value: string | undefined): SslConfig | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "true" || lowered === "1") return true;
  if (lowered === "false" || lowered === "0") return false;
  if (lowered === "amazon-rds" || lowered === "rds") return "Amazon RDS";
  throw new ConfigError(
    `MYSQL_SSL must be one of: true, false, amazon-rds (got "${value}")`,
  );
}

function parseBoolEnv(value: string | undefined): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

function buildPlaceholderError(
  filePath: string | null,
  totalConnections: number,
): string {
  const where = filePath ? `config file ${filePath}` : "environment variables";
  return [
    `All ${totalConnections} connection(s) from ${where} look like the placeholder example`,
    `(any field containing "${PLACEHOLDER_TOKEN}" is rejected).`,
    "",
    "Replace the placeholder values (e.g. \"your-password\") with real credentials.",
    "See config.example.json or run: mcp-server-mysql init",
  ].join("\n");
}

function buildNoSourceError(): string {
  return [
    "No MySQL config found. Tried (in order):",
    "  1. --config <path>",
    "  2. $MCP_MYSQL_CONFIG",
    "  3. ./mcp-mysql.config.json",
    "  4. ~/.config/mcp-server-mysql/config.json",
    "  5. Environment vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE",
    "",
    "Generate a starter config with: mcp-server-mysql init",
    "Or set the four required MYSQL_* environment variables.",
  ].join("\n");
}

export const __internals = {
  buildConfigFromEnv,
  filterPlaceholders,
  validate,
  parseBoolEnv,
  parseSslEnv,
};

export { z };
