import type { RowDataPacket } from "mysql2";

import { requireNonEmptyString } from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { qualifiedName, resolveOptionalDatabase } from "../lib/database.js";
import { assertValidIdentifier } from "../lib/identifiers.js";

export const describeTableTool: ToolDefinition = {
  name: "describe_table",

  describe(ctx) {
    return {
      name: "describe_table",
      description:
        `Describe the columns and indexes of a table. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Describe table",
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
              "Table name. 1-64 chars, no backticks or control characters. " +
              "Identifiers with dollar signs, hyphens, and unicode letters are OK.",
          },
          database: {
            type: "string",
            description:
              "Optional schema the table lives in. Defaults to the " +
              "connection's own database.",
          },
          connection: connectionEnum(ctx),
        },
        required: ["table"],
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const table = requireNonEmptyString(args.table, "table");
    assertValidIdentifier(table, "table");
    const database = resolveOptionalDatabase(args.database);

    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);
    const quoted = qualifiedName(table, database);

    const [[columns], [indexes]] = await Promise.all([
      pool.query<RowDataPacket[]>(`DESCRIBE ${quoted}`),
      pool.query<RowDataPacket[]>(`SHOW INDEXES FROM ${quoted}`),
    ]);

    return {
      table,
      database: database ?? undefined,
      columns,
      indexes,
      connection: connectionName,
    };
  },
};
