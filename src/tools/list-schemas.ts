import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";

export const listSchemasTool: ToolDefinition = {
  name: "list_schemas",

  describe(ctx) {
    return {
      name: "list_schemas",
      description:
        `List the databases (schemas) visible to the connection's user ` +
        `via SHOW DATABASES. Use the returned names as the "database" ` +
        `argument to list_tables, get_schema, describe_table, and the ` +
        `other schema tools to inspect a different schema on the same ` +
        `server. Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "List schemas",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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
    const [rows] = await pool.query<RowDataPacket[]>("SHOW DATABASES");

    const schemas = rows.map((row) => {
      const value = Object.values(row)[0];
      return typeof value === "string" ? value : String(value);
    });

    return {
      connection: connectionName,
      count: schemas.length,
      schemas,
    };
  },
};
