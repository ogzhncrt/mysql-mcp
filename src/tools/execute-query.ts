import type { FieldPacket, ResultSetHeader, RowDataPacket } from "mysql2";

import { MAX_QUERY_LIMIT } from "../config/types.js";
import {
  assertCanExecute,
  containsTopLevelLimit,
  findOuterSelectEnd,
  isMultiStatement,
  stripCommentsAndStrings,
  trimTrailingNoise,
} from "../db/query-guard.js";
import {
  resolveParams,
  resolvePositiveInt,
  requireNonEmptyString,
} from "../lib/args.js";
import {
  allConnectionsReadOnly,
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { capBySerializedSize } from "../lib/json.js";

const FORMATS = ["objects", "compact"] as const;
type RowFormat = (typeof FORMATS)[number];

export const executeQueryTool: ToolDefinition = {
  name: "execute_query",

  describe(ctx) {
    const readOnly = allConnectionsReadOnly(ctx);
    return {
      name: "execute_query",
      description:
        `Execute a SQL query against a configured MySQL connection. ` +
        `Configured connections: ${connectionSummary(ctx)}. ` +
        `Read-only connections allow only read statements ` +
        `(SELECT/SHOW/EXPLAIN/DESCRIBE/WITH...SELECT/TABLE/VALUES/HELP/CHECKSUM); ` +
        `everything else, including CTE-disguised writes, LOAD DATA, SET, ` +
        `KILL, transaction control, and SELECT ... INTO OUTFILE, is rejected. ` +
        `Bare SELECTs and WITH...SELECT CTEs are auto-LIMITed ` +
        `(default ${ctx.defaultQueryLimit}, hard max ${MAX_QUERY_LIMIT}). ` +
        `They also get a MAX_EXECUTION_TIME optimizer hint so the ` +
        `timeout actually cancels the query server-side on MySQL 5.7.4+. ` +
        `Pass "params" to use parameterized queries with ? placeholders. ` +
        `Note: each call may run on a different pooled connection, so ` +
        `session state (transactions, SET, USE, temp tables) does not ` +
        `persist between calls.`,
      annotations: {
        title: "Execute SQL query",
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        openWorldHint: false,
      },
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
          format: {
            type: "string",
            enum: [...FORMATS],
            description:
              `Row output format. "objects" (default) returns one JSON object ` +
              `per row. "compact" returns { columns: [...], rows: [[...]] }, ` +
              `much smaller for wide result sets; prefer it for large reads.`,
            default: "objects",
          },
          maxResponseBytes: {
            type: "number",
            description:
              `Approximate cap on the serialized size of returned rows. ` +
              `Default ${ctx.defaultMaxResponseBytes}. When exceeded, rows are ` +
              `truncated and the response says so.`,
            default: ctx.defaultMaxResponseBytes,
            minimum: 1024,
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
    const format = resolveFormat(args.format);
    const maxResponseBytes = resolvePositiveInt(
      args.maxResponseBytes,
      ctx.defaultMaxResponseBytes,
      { field: "maxResponseBytes", min: 1024 },
    );

    assertCanExecute(connection, query);

    const limited = maybeAppendLimit(query, limit);
    const finalQuery = injectMaxExecutionTime(limited, timeoutMs);
    const pool = ctx.pools.getPool(connectionName);

    const [result, fields] = params
      ? await pool.query({ sql: finalQuery, timeout: timeoutMs, values: params })
      : await pool.query({ sql: finalQuery, timeout: timeoutMs });

    return buildResponse({
      connection: connectionName,
      originalQuery: query,
      result,
      fields: fields as FieldPacket[] | undefined,
      format,
      maxResponseBytes,
    });
  },
};

function resolveFormat(value: unknown): RowFormat {
  if (value === undefined || value === null) return "objects";
  if (typeof value !== "string" || !FORMATS.includes(value as RowFormat)) {
    throw new Error(`"format" must be one of ${FORMATS.join(", ")}`);
  }
  return value as RowFormat;
}

/**
 * Appends `LIMIT n` to bare SELECTs and `WITH ... SELECT` CTEs. The limit
 * goes on its own line after trailing comments/semicolons are removed, so a
 * query ending in `-- note` can't swallow the LIMIT into the comment (1.2
 * bug). Multi-statement batches are skipped: a trailing LIMIT would bind
 * only to the last statement and leave earlier SELECTs uncapped.
 */
function maybeAppendLimit(query: string, limit: number): string {
  if (findOuterSelectEnd(query) === null) return query;
  if (isMultiStatement(query)) return query;
  if (containsTopLevelLimit(query)) return query;
  return `${trimTrailingNoise(query)}\nLIMIT ${limit}`;
}

/**
 * Injects /*+ MAX_EXECUTION_TIME(N) *\/ right after the top-level SELECT
 * keyword, for both bare `SELECT ...` and `WITH ... SELECT ...` CTEs whose
 * main statement is a SELECT. Returns the query unchanged for writes and
 * non-SELECT reads.
 *
 * The hint is a no-op on MySQL < 5.7.4 and MariaDB (just a comment), so
 * injecting it is safe even when we don't know the server version.
 */
export function injectMaxExecutionTime(
  sql: string,
  timeoutMs: number,
): string {
  const pos = findOuterSelectEnd(sql);
  if (pos === null) return sql;
  return `${sql.slice(0, pos)} /*+ MAX_EXECUTION_TIME(${timeoutMs}) */${sql.slice(pos)}`;
}

interface BuildResponseInput {
  connection: string;
  originalQuery: string;
  result: unknown;
  fields: FieldPacket[] | undefined;
  format: RowFormat;
  maxResponseBytes: number;
}

function buildResponse(input: BuildResponseInput): Record<string, unknown> {
  const { connection, originalQuery, result, fields, format, maxResponseBytes } =
    input;
  const queryType = detectQueryType(originalQuery);

  if (Array.isArray(result)) {
    return buildRowsResponse(
      connection,
      queryType,
      result as RowDataPacket[],
      fields,
      format,
      maxResponseBytes,
    );
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

function buildRowsResponse(
  connection: string,
  queryType: string,
  rows: RowDataPacket[],
  fields: FieldPacket[] | undefined,
  format: RowFormat,
  maxResponseBytes: number,
): Record<string, unknown> {
  const columns = resolveColumns(rows, fields);

  const outputRows: unknown[] =
    format === "compact"
      ? rows.map((row) => columns.map((col) => row[col]))
      : rows;

  const { kept, truncated } = capBySerializedSize(outputRows, maxResponseBytes);

  const base: Record<string, unknown> = {
    connection,
    queryType,
    rowCount: kept.length,
  };

  if (format === "compact") {
    base.columns = columns;
    base.rows = kept;
  } else {
    base.rows = kept;
  }

  if (truncated) {
    base.truncated = true;
    base.fetchedRowCount = rows.length;
    base.note =
      `Response truncated: ${kept.length} of ${rows.length} fetched rows ` +
      `fit within maxResponseBytes=${maxResponseBytes}. Narrow the SELECT, ` +
      `lower the LIMIT, or use format:"compact".`;
  }

  return base;
}

function resolveColumns(
  rows: RowDataPacket[],
  fields: FieldPacket[] | undefined,
): string[] {
  if (fields && fields.length > 0) {
    return fields.map((f) => f.name);
  }
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

function detectQueryType(sql: string): string {
  const masked = stripCommentsAndStrings(sql);
  const firstWord = masked.trim().split(/\s+/)[0]?.toUpperCase();
  return firstWord || "OTHER";
}
