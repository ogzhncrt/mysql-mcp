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

  const candidates: Array<string | undefined> = [
    options.cliConfigPath,
    env.MCP_MYSQL_CONFIG,
    join(cwd, "mcp-mysql.config.json"),
    join(homedir(), ".config", "mcp-server-mysql", "config.json"),
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

  const connectionName =
    env.MYSQL_CONNECTION_NAME?.trim() || DEFAULT_CONNECTION_NAME;
  const readOnly = parseBoolEnv(env.MYSQL_READ_ONLY);
  const ssl = parseSslEnv(env.MYSQL_SSL);

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
        host,
        ...(port !== undefined ? { port } : {}),
        user,
        password,
        database,
        readOnly,
        ...(queryTimeoutMs !== undefined ? { queryTimeoutMs } : {}),
        ...(ssl !== undefined ? { ssl } : {}),
      },
    ],
  };
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
