import type { ResultSetHeader, RowDataPacket } from "mysql2";

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
        `Read-only connections reject INSERT/UPDATE/DELETE/DDL. ` +
        `Bare SELECTs are auto-LIMITed to the requested limit (default ${ctx.defaultQueryLimit}).`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Raw SQL to execute.",
          },
          connection: connectionEnum(ctx),
          limit: {
            type: "number",
            description:
              `Row cap appended to bare SELECT queries (default ${ctx.defaultQueryLimit}).`,
            default: ctx.defaultQueryLimit,
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

    const connectionName = resolveConnectionName(ctx, args.connection);
    const connection = ctx.pools.getConfig(connectionName);
    const limit = resolveLimit(args.limit, ctx.defaultQueryLimit);

    assertCanExecute(connection, query);

    const finalQuery = maybeAppendLimit(query, limit);
    const pool = ctx.pools.getPool(connectionName);
    const [result] = await pool.query(finalQuery);

    return buildResponse(connectionName, query, result);
  },
};

function resolveLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('"limit" must be a finite number');
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('"limit" must be a positive integer');
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
