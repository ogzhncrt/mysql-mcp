import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { resolveOptionalDatabase, schemaScope } from "../lib/database.js";

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
        `create/update time. Row counts are estimates for InnoDB, so use ` +
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
          database: {
            type: "string",
            description:
              "Optional schema to inspect. Defaults to the connection's " +
              "own database.",
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
    const database = resolveOptionalDatabase(args.database);
    const scope = schemaScope(database);

    const table = args.table;
    if (table !== undefined && typeof table !== "string") {
      throw new Error('"table" must be a string when provided');
    }

    const baseSql =
      scope.expr === "DATABASE()"
        ? STATS_SQL
        : STATS_SQL.replace("DATABASE()", scope.expr);
    const sql = table
      ? `${baseSql} AND TABLE_NAME = ? ORDER BY TABLE_NAME`
      : `${baseSql} ORDER BY DATA_LENGTH + INDEX_LENGTH DESC`;
    const values = [...scope.values, ...(table ? [table] : [])];

    const [rows] = values.length > 0
      ? await pool.query<RowDataPacket[]>({ sql, values })
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
