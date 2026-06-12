import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";

const STATS_SQL = `
SELECT
  TABLE_NAME,
  TABLE_TYPE,
  ENGINE,
  TABLE_ROWS,
  AVG_ROW_LENGTH,
  DATA_LENGTH,
  INDEX_LENGTH,
  AUTO_INCREMENT,
  TABLE_COLLATION,
  CREATE_TIME,
  UPDATE_TIME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
`.trim();

export const tableStatsTool: ToolDefinition = {
  name: "table_stats",

  describe(ctx) {
    return {
      name: "table_stats",
      description:
        `Size and row-count statistics for tables in the selected database, ` +
        `from information_schema.TABLES: approximate row count, data and ` +
        `index size in bytes, engine, collation, auto-increment value, ` +
        `create/update time. Row counts are estimates for InnoDB — use ` +
        `SELECT COUNT(*) when you need the exact number. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Table statistics",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description:
              "Optional table name. When omitted, stats for every table " +
              "in the database are returned, largest first.",
          },
          connection: connectionEnum(ctx),
        },
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    const table = args.table;
    if (table !== undefined && typeof table !== "string") {
      throw new Error('"table" must be a string when provided');
    }

    const sql = table
      ? `${STATS_SQL} AND TABLE_NAME = ? ORDER BY TABLE_NAME`
      : `${STATS_SQL} ORDER BY DATA_LENGTH + INDEX_LENGTH DESC`;

    const [rows] = table
      ? await pool.query<RowDataPacket[]>({ sql, values: [table] })
      : await pool.query<RowDataPacket[]>({ sql });

    const tables = rows.map((row) => ({
      table: row.TABLE_NAME,
      type: row.TABLE_TYPE,
      engine: row.ENGINE,
      approxRows: row.TABLE_ROWS,
      avgRowBytes: row.AVG_ROW_LENGTH,
      dataBytes: row.DATA_LENGTH,
      indexBytes: row.INDEX_LENGTH,
      autoIncrement: row.AUTO_INCREMENT,
      collation: row.TABLE_COLLATION,
      createdAt: row.CREATE_TIME,
      updatedAt: row.UPDATE_TIME,
    }));

    return {
      connection: connectionName,
      count: tables.length,
      tables,
    };
  },
};
