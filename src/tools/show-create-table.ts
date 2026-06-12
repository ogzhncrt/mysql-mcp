import type { RowDataPacket } from "mysql2";

import { requireNonEmptyString } from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { assertValidIdentifier, escapeIdentifier } from "../lib/identifiers.js";

export const showCreateTableTool: ToolDefinition = {
  name: "show_create_table",

  describe(ctx) {
    return {
      name: "show_create_table",
      description:
        `Return the full CREATE TABLE statement for a table — including ` +
        `column types, defaults, indexes, foreign keys, engine, and charset. ` +
        `More complete than describe_table when reasoning about schema. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Show CREATE TABLE",
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
              "Table name. 1–64 chars, no backticks or control characters.",
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

    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SHOW CREATE TABLE ${escapeIdentifier(table)}`,
    );

    const row = rows[0] ?? {};
    const createStatement =
      (row["Create Table"] as string | undefined) ??
      (row["Create View"] as string | undefined) ??
      null;

    return {
      table,
      connection: connectionName,
      createStatement,
    };
  },
};
