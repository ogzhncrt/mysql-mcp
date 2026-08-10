import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { resolveOptionalDatabase, schemaScope } from "../lib/database.js";

const FK_SQL = `
SELECT
  kcu.CONSTRAINT_NAME,
  kcu.TABLE_NAME,
  kcu.COLUMN_NAME,
  kcu.REFERENCED_TABLE_NAME,
  kcu.REFERENCED_COLUMN_NAME,
  kcu.ORDINAL_POSITION,
  rc.UPDATE_RULE,
  rc.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
 AND rc.TABLE_NAME = kcu.TABLE_NAME
WHERE kcu.TABLE_SCHEMA = DATABASE()
  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
`.trim();

interface ForeignKey {
  constraint: string;
  table: string;
  referencedTable: string;
  columns: Array<{ column: string; referencedColumn: string }>;
  updateRule: string;
  deleteRule: string;
}

export const listForeignKeysTool: ToolDefinition = {
  name: "list_foreign_keys",

  describe(ctx) {
    return {
      name: "list_foreign_keys",
      description:
        `List foreign key relationships in the selected database. ` +
        `Pass "table" to see both directions: foreign keys defined on that ` +
        `table and foreign keys in other tables referencing it. ` +
        `Multi-column keys are grouped per constraint. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "List foreign keys",
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
              "Optional table name. When omitted, all foreign keys in the " +
              "database are returned.",
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
        ? FK_SQL
        : FK_SQL.replace("DATABASE()", scope.expr);
    const sql = table
      ? `${baseSql} AND (kcu.TABLE_NAME = ? OR kcu.REFERENCED_TABLE_NAME = ?)
ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`
      : `${baseSql}
ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`;
    const values = [...scope.values, ...(table ? [table, table] : [])];

    const [rows] = values.length > 0
      ? await pool.query<RowDataPacket[]>({ sql, values })
      : await pool.query<RowDataPacket[]>({ sql });

    const grouped = new Map<string, ForeignKey>();
    for (const row of rows) {
      const key = `${row.TABLE_NAME}\u0000${row.CONSTRAINT_NAME}`;
      let fk = grouped.get(key);
      if (!fk) {
        fk = {
          constraint: String(row.CONSTRAINT_NAME),
          table: String(row.TABLE_NAME),
          referencedTable: String(row.REFERENCED_TABLE_NAME),
          columns: [],
          updateRule: String(row.UPDATE_RULE),
          deleteRule: String(row.DELETE_RULE),
        };
        grouped.set(key, fk);
      }
      fk.columns.push({
        column: String(row.COLUMN_NAME),
        referencedColumn: String(row.REFERENCED_COLUMN_NAME),
      });
    }

    const foreignKeys = [...grouped.values()];

    return {
      connection: connectionName,
      count: foreignKeys.length,
      foreignKeys,
    };
  },
};
