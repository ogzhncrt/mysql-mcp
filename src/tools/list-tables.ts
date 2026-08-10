import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { resolveOptionalDatabase } from "../lib/database.js";
import { escapeIdentifier } from "../lib/identifiers.js";

export const listTablesTool: ToolDefinition = {
  name: "list_tables",

  describe(ctx) {
    return {
      name: "list_tables",
      description:
        `List all tables in the selected MySQL database. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "List tables",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          database: {
            type: "string",
            description:
              "Optional schema to list. Defaults to the connection's own " +
              "database.",
          },
          connection: connectionEnum(ctx),
        },
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const connectionName = resolveConnectionName(ctx, args.connection);
    const database = resolveOptionalDatabase(args.database);
    const pool = ctx.pools.getPool(connectionName);
    const sql = database
      ? `SHOW TABLES FROM ${escapeIdentifier(database)}`
      : "SHOW TABLES";
    const [rows] = await pool.query<RowDataPacket[]>(sql);

    const tables = rows.map((row) => {
      const value = Object.values(row)[0];
      return typeof value === "string" ? value : String(value);
    });

    return {
      tables,
      connection: connectionName,
      database: database ?? undefined,
      count: tables.length,
    };
  },
};
