import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";

export const listTablesTool: ToolDefinition = {
  name: "list_tables",

  describe(ctx) {
    return {
      name: "list_tables",
      description:
        `List all tables in the selected MySQL database. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      inputSchema: {
        type: "object",
        properties: {
          connection: connectionEnum(ctx),
        },
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);
    const [rows] = await pool.query<RowDataPacket[]>("SHOW TABLES");

    const tables = rows.map((row) => {
      const value = Object.values(row)[0];
      return typeof value === "string" ? value : String(value);
    });

    return {
      tables,
      connection: connectionName,
      count: tables.length,
    };
  },
};
