import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
  type ToolDefinition,
} from "./registry.js";

const TABLE_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

export const describeTableTool: ToolDefinition = {
  name: "describe_table",

  describe(ctx) {
    return {
      name: "describe_table",
      description:
        `Describe the columns and indexes of a table. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "Table name. Must match /^[a-zA-Z0-9_]+$/.",
          },
          connection: connectionEnum(ctx),
        },
        required: ["table"],
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const table = args.table;
    if (typeof table !== "string" || table.trim() === "") {
      throw new Error('"table" is required and must be a non-empty string');
    }
    if (!TABLE_NAME_REGEX.test(table)) {
      throw new Error(
        `"table" must match /^[a-zA-Z0-9_]+$/ (got "${table}")`,
      );
    }

    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    const [columns] = await pool.query<RowDataPacket[]>(
      `DESCRIBE \`${table}\``,
    );
    const [indexes] = await pool.query<RowDataPacket[]>(
      `SHOW INDEXES FROM \`${table}\``,
    );

    return {
      table,
      columns,
      indexes,
      connection: connectionName,
    };
  },
};
