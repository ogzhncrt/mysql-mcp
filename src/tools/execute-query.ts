import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { MAX_QUERY_LIMIT } from "../config/types.js";
import {
  assertCanExecute,
  containsLimitClause,
  isSelectQuery,
  isWriteQuery,
  normalizeForPrefix,
} from "../db/query-guard.js";
import {
  resolveParams,
  resolvePositiveInt,
  requireNonEmptyString,
} from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";

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
        `SELECTs also get a MAX_EXECUTION_TIME optimizer hint so the ` +
        `timeout actually cancels the query server-side on MySQL 5.7.4+. ` +
        `Pass "params" to use parameterized queries with ? placeholders.`,
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
              `Per-query timeout in milliseconds. Default ${ctx.defaultQueryTimeoutMs}. ` +
              `For SELECT, cancels the query server-side via MAX_EXECUTION_TIME. ` +
              `For non-SELECT, only closes the client socket (server may keep running).`,
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
    const query = requireNonEmptyString(args.query, "query");
    const params = resolveParams(args.params);
    const connectionName = resolveConnectionName(ctx, args.connection);
    const connection = ctx.pools.getConfig(connectionName);
    const limit = resolvePositiveInt(args.limit, ctx.defaultQueryLimit, {
      field: "limit",
      max: MAX_QUERY_LIMIT,
    });
    const timeoutMs = resolvePositiveInt(
      args.timeoutMs,
      connection.queryTimeoutMs ?? ctx.defaultQueryTimeoutMs,
      { field: "timeoutMs" },
    );

    assertCanExecute(connection, query);

    const limited = maybeAppendLimit(query, limit);
    const finalQuery = injectMaxExecutionTime(limited, timeoutMs);
    const pool = ctx.pools.getPool(connectionName);

    const [result] = params
      ? await pool.query({ sql: finalQuery, timeout: timeoutMs, values: params })
      : await pool.query({ sql: finalQuery, timeout: timeoutMs });

    return buildResponse(connectionName, query, result);
  },
};

function maybeAppendLimit(query: string, limit: number): string {
  if (!isSelectQuery(query)) return query;
  if (containsLimitClause(query)) return query;
  const trimmed = query.trimEnd().replace(/;+$/, "");
  return `${trimmed} LIMIT ${limit}`;
}

/**
 * Injects /*+ MAX_EXECUTION_TIME(N) *\/ right after the leading SELECT
 * keyword if the query is a top-level SELECT. Returns the query unchanged
 * otherwise. CTE queries (WITH ... SELECT) are not handled — parsing them
 * correctly requires tracking paren depth.
 *
 * The hint is a no-op on MySQL < 5.7.4 and MariaDB (just a comment), so
 * injecting it is safe even when we don't know the server version.
 */
export function injectMaxExecutionTime(
  sql: string,
  timeoutMs: number,
): string {
  const pos = findLeadingSelectEnd(sql);
  if (pos === null) return sql;
  return `${sql.slice(0, pos)} /*+ MAX_EXECUTION_TIME(${timeoutMs}) */${sql.slice(pos)}`;
}

function findLeadingSelectEnd(sql: string): number | null {
  const len = sql.length;
  let i = 0;
  while (i < len) {
    const c = sql[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (c === "#") {
      const end = sql.indexOf("\n", i + 1);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (sql.slice(i, i + 6).toUpperCase() === "SELECT") {
      const after = sql[i + 6];
      if (after === undefined || !/[A-Za-z0-9_]/.test(after)) {
        return i + 6;
      }
    }
    return null;
  }
  return null;
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
