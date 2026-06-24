import type { RowDataPacket } from "mysql2";

import { requireNonEmptyString } from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";

const MAX_MATCHES = 500;

const SEARCH_SQL = `
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_KEY,
  COLUMN_DEFAULT,
  EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND COLUMN_NAME LIKE ? ESCAPE '!'
ORDER BY TABLE_NAME, ORDINAL_POSITION
LIMIT ${MAX_MATCHES}
`.trim();

export const searchColumnsTool: ToolDefinition = {
  name: "search_columns",

  describe(ctx) {
    return {
      name: "search_columns",
      description:
        `Find columns by name across every table in the selected database ` +
        `(case-insensitive substring match). Useful for locating where a ` +
        `field lives — e.g. "email" or "tenant_id" — without describing ` +
        `tables one by one. Returns up to ${MAX_MATCHES} matches with table, ` +
        `type, nullability, and key info. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Search columns",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Substring to match against column names, e.g. \"email\". " +
              "Matched case-insensitively; % and _ are treated literally.",
          },
          connection: connectionEnum(ctx),
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const pattern = requireNonEmptyString(args.pattern, "pattern");
    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    // Escape LIKE wildcards so the user's pattern is a literal substring.
    // Uses "!" as the ESCAPE character (declared in SEARCH_SQL) rather than
    // the default backslash: backslash escaping is unreliable across the
    // NO_BACKSLASH_ESCAPES SQL mode and the driver's own backslash doubling.
    const escaped = pattern.replace(/([!%_])/g, "!$1");

    const [rows] = await pool.query<RowDataPacket[]>({
      sql: SEARCH_SQL,
      values: [`%${escaped}%`],
    });

    const columns = rows.map((row) => ({
      table: row.TABLE_NAME,
      column: row.COLUMN_NAME,
      type: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === "YES",
      key: row.COLUMN_KEY || null,
      default: row.COLUMN_DEFAULT,
      extra: row.EXTRA || null,
    }));

    return {
      connection: connectionName,
      pattern,
      count: columns.length,
      truncated: columns.length === MAX_MATCHES,
      columns,
    };
  },
};
