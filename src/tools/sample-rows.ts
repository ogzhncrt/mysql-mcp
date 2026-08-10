import type { FieldPacket, RowDataPacket } from "mysql2";

import { resolvePositiveInt, requireNonEmptyString } from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { qualifiedName, resolveOptionalDatabase } from "../lib/database.js";
import { assertValidIdentifier } from "../lib/identifiers.js";
import { capBySerializedSize } from "../lib/json.js";

const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 1000;

export const sampleRowsTool: ToolDefinition = {
  name: "sample_rows",

  describe(ctx) {
    return {
      name: "sample_rows",
      description:
        `Return a few example rows from a table (SELECT * ... LIMIT n) so ` +
        `you can see real data shape and values without hand-writing SQL. ` +
        `Default ${DEFAULT_SAMPLE_LIMIT} rows, max ${MAX_SAMPLE_LIMIT}. ` +
        `Always a read, so it is safe on read-only connections. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Sample table rows",
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
              "Table name. 1-64 chars, no backticks or control characters.",
          },
          database: {
            type: "string",
            description:
              "Optional schema the table lives in. Defaults to the " +
              "connection's own database.",
          },
          limit: {
            type: "number",
            description: `Number of rows to return. Default ${DEFAULT_SAMPLE_LIMIT}, max ${MAX_SAMPLE_LIMIT}.`,
            default: DEFAULT_SAMPLE_LIMIT,
            minimum: 1,
            maximum: MAX_SAMPLE_LIMIT,
          },
          connection: connectionEnum(ctx),
          maxResponseBytes: {
            type: "number",
            description:
              `Approximate cap on the serialized size of returned rows. ` +
              `Default ${ctx.defaultMaxResponseBytes}.`,
            default: ctx.defaultMaxResponseBytes,
            minimum: 1024,
          },
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
    const limit = resolvePositiveInt(args.limit, DEFAULT_SAMPLE_LIMIT, {
      field: "limit",
      max: MAX_SAMPLE_LIMIT,
    });
    const maxResponseBytes = resolvePositiveInt(
      args.maxResponseBytes,
      ctx.defaultMaxResponseBytes,
      { field: "maxResponseBytes", min: 1024 },
    );

    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    const [rows, fields] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM ${qualifiedName(table, database)} LIMIT ${limit}`,
    );

    const columns = resolveColumns(rows, fields as FieldPacket[] | undefined);
    const { kept, truncated } = capBySerializedSize(rows, maxResponseBytes);

    const response: Record<string, unknown> = {
      connection: connectionName,
      table,
      database: database ?? undefined,
      columns,
      rowCount: kept.length,
      rows: kept,
    };

    if (truncated) {
      response.truncated = true;
      response.fetchedRowCount = rows.length;
      response.note =
        `Response truncated: ${kept.length} of ${rows.length} rows fit ` +
        `within maxResponseBytes=${maxResponseBytes}. Lower "limit".`;
    }

    return response;
  },
};

function resolveColumns(
  rows: RowDataPacket[],
  fields: FieldPacket[] | undefined,
): string[] {
  if (fields && fields.length > 0) return fields.map((f) => f.name);
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}
