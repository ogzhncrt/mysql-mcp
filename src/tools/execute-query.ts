import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { MAX_QUERY_LIMIT } from "../config/types.js";
import {
  assertCanExecute,
  isSelectQuery,
  isWriteQuery,
  normalizeForPrefix,
} from "../db/query-guard.js";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
  type ToolContext,
  type ToolDefinition,
} from "./registry.js";

const LIMIT_REGEX = /\bLIMIT\b/i;

export const executeQueryTool: ToolDefinition = {
  name: "execute_query",

  describe(ctx) {
    return {
      name: "execute_query",
      description:
        `Execute a SQL query against a configured MySQL connection. ` +
        `Configured connections: ${connectionSummary(ctx)}. ` +
        `Read-only connections reject INSERT/UPDATE/DELETE/DDL/CALL ` +
        `(detection is comment- and string-literal-aware, so CTE bypasses ` +
        `like "WITH x AS (...) DELETE FROM t" are blocked). ` +
        `Bare SELECTs are auto-LIMITed (default ${ctx.defaultQueryLimit}, ` +
        `hard max ${MAX_QUERY_LIMIT}). ` +
        `Pass "params" to use parameterized queries with ? placeholders; ` +
        `this is safer than string-interpolating values into "query".`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "SQL statement. Use ? placeholders with `params`.",
          },
          params: {
            type: "array",
            description:
              "Optional values for ? placeholders in `query`. " +
              "Each value is escaped by the driver, preventing SQL injection.",
            items: {},
          },
          connection: connectionEnum(ctx),
          limit: {
            type: "number",
            description:
              `Row cap appended to bare SELECT queries (default ${ctx.defaultQueryLimit}, max ${MAX_QUERY_LIMIT}).`,
            default: ctx.defaultQueryLimit,
            minimum: 1,
            maximum: MAX_QUERY_LIMIT,
          },
          timeoutMs: {
            type: "number",
            description:
              `Per-query timeout in milliseconds. Default ${ctx.defaultQueryTimeoutMs}.`,
            default: ctx.defaultQueryTimeoutMs,
            minimum: 1,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const query = args.query;
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error('"query" is required and must be a non-empty string');
    }

    const params = resolveParams(args.params);
    const connectionName = resolveConnectionName(ctx, args.connection);
    const connection = ctx.pools.getConfig(connectionName);
    const limit = resolveLimit(args.limit, ctx.defaultQueryLimit);
    const timeoutMs = resolveTimeout(
      args.timeoutMs,
      connection.queryTimeoutMs ?? ctx.defaultQueryTimeoutMs,
    );

    assertCanExecute(connection, query);

    const finalQuery = maybeAppendLimit(query, limit);
    const pool = ctx.pools.getPool(connectionName);

    const [result] = params
      ? await pool.query({ sql: finalQuery, timeout: timeoutMs, values: params })
      : await pool.query({ sql: finalQuery, timeout: timeoutMs });

    return buildResponse(connectionName, query, result);
  },
};

function resolveParams(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error('"params" must be an array when provided');
  }
  return value;
}

function resolveLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('"limit" must be a finite number');
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('"limit" must be a positive integer');
  }
  if (value > MAX_QUERY_LIMIT) {
    throw new Error(`"limit" must be <= ${MAX_QUERY_LIMIT}`);
  }
  return value;
}

function resolveTimeout(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('"timeoutMs" must be a finite number');
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('"timeoutMs" must be a positive integer');
  }
  return value;
}

function maybeAppendLimit(query: string, limit: number): string {
  if (!isSelectQuery(query)) return query;
  if (LIMIT_REGEX.test(query)) return query;
  const trimmed = query.trimEnd().replace(/;$/, "");
  return `${trimmed} LIMIT ${limit}`;
}

function buildResponse(
  connection: string,
  originalQuery: string,
  result: unknown,
): Record<string, unknown> {
  const queryType = detectQueryType(originalQuery);

  if (Array.isArray(result)) {
    const rows = result as RowDataPacket[];
    return {
      connection,
      queryType,
      rows,
      rowCount: rows.length,
    };
  }

  const header = result as ResultSetHeader;

  if (queryType === "INSERT") {
    return {
      connection,
      queryType,
      affectedRows: header.affectedRows ?? 0,
      insertId: header.insertId != null ? String(header.insertId) : null,
      message: `Successfully inserted ${header.affectedRows ?? 0} row(s)`,
    };
  }

  if (queryType === "UPDATE") {
    return {
      connection,
      queryType,
      affectedRows: header.affectedRows ?? 0,
      changedRows: header.changedRows ?? 0,
      message: `Successfully updated ${header.affectedRows ?? 0} row(s) (${
        header.changedRows ?? 0
      } changed)`,
    };
  }

  if (queryType === "DELETE") {
    return {
      connection,
      queryType,
      affectedRows: header.affectedRows ?? 0,
      changedRows: header.changedRows ?? 0,
      message: `Successfully deleted ${header.affectedRows ?? 0} row(s)`,
    };
  }

  return {
    connection,
    queryType,
    affectedRows: header.affectedRows ?? 0,
    message: "Query executed successfully",
  };
}

function detectQueryType(sql: string): string {
  const normalized = normalizeForPrefix(sql);
  if (normalized.startsWith("SELECT")) return "SELECT";
  if (normalized.startsWith("INSERT")) return "INSERT";
  if (normalized.startsWith("UPDATE")) return "UPDATE";
  if (normalized.startsWith("DELETE")) return "DELETE";
  if (isWriteQuery(sql)) {
    const firstWord = normalized.split(/\s+/)[0];
    return firstWord || "OTHER";
  }
  const firstWord = normalized.split(/\s+/)[0];
  return firstWord || "OTHER";
}
