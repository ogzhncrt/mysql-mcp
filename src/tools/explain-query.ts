import type { RowDataPacket } from "mysql2";

import { normalizeForPrefix } from "../db/query-guard.js";
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

const FORMATS = ["TRADITIONAL", "JSON", "TREE"] as const;
type Format = (typeof FORMATS)[number];

export const explainQueryTool: ToolDefinition = {
  name: "explain_query",

  describe(ctx) {
    return {
      name: "explain_query",
      description:
        `Run EXPLAIN on a SQL statement without executing it. ` +
        `Useful for inspecting the query plan, index usage, and estimated ` +
        `row counts before running an expensive query — especially on ` +
        `read-only production connections. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "SQL to explain. May be SELECT/INSERT/UPDATE/DELETE/REPLACE; " +
              "EXPLAIN reports the plan without executing.",
          },
          params: {
            type: "array",
            description: "Optional values for ? placeholders in `query`.",
            items: {},
          },
          format: {
            type: "string",
            enum: [...FORMATS],
            description:
              "Output format. TRADITIONAL = tabular rows (default). " +
              "JSON = nested plan object. TREE = MySQL 8.0+ readable tree.",
            default: "TRADITIONAL",
          },
          connection: connectionEnum(ctx),
          timeoutMs: {
            type: "number",
            description: `Per-query timeout in milliseconds. Default ${ctx.defaultQueryTimeoutMs}.`,
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
    rejectAnalyze(query);

    const format = resolveFormat(args.format);
    const params = resolveParams(args.params);
    const connectionName = resolveConnectionName(ctx, args.connection);
    const connection = ctx.pools.getConfig(connectionName);
    const timeoutMs = resolvePositiveInt(
      args.timeoutMs,
      connection.queryTimeoutMs ?? ctx.defaultQueryTimeoutMs,
      { field: "timeoutMs" },
    );

    const stripped = query.trimEnd().replace(/;+$/, "");
    const explainSql =
      format === "TRADITIONAL"
        ? `EXPLAIN ${stripped}`
        : `EXPLAIN FORMAT=${format} ${stripped}`;

    const pool = ctx.pools.getPool(connectionName);
    const [rows] = params
      ? await pool.query<RowDataPacket[]>({
          sql: explainSql,
          timeout: timeoutMs,
          values: params,
        })
      : await pool.query<RowDataPacket[]>({
          sql: explainSql,
          timeout: timeoutMs,
        });

    return {
      connection: connectionName,
      format,
      plan: rows,
    };
  },
};

function rejectAnalyze(query: string): void {
  const normalized = normalizeForPrefix(query);
  if (
    normalized === "ANALYZE" ||
    normalized.startsWith("ANALYZE ") ||
    normalized.startsWith("ANALYZE\n") ||
    normalized.startsWith("ANALYZE\t")
  ) {
    throw new Error(
      '"query" must not start with ANALYZE; use execute_query for ANALYZE statements',
    );
  }
}

function resolveFormat(value: unknown): Format {
  if (value === undefined || value === null) return "TRADITIONAL";
  if (typeof value !== "string") {
    throw new Error('"format" must be a string');
  }
  const upper = value.toUpperCase();
  if (!FORMATS.includes(upper as Format)) {
    throw new Error(
      `"format" must be one of ${FORMATS.join(", ")} (got "${value}")`,
    );
  }
  return upper as Format;
}
