import type { RowDataPacket } from "mysql2";

import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import { capBySerializedSize } from "../lib/json.js";

/** Curated, low-cardinality server variables worth surfacing by default. */
const VARIABLES = [
  "version",
  "version_comment",
  "max_connections",
  "wait_timeout",
  "interactive_timeout",
  "max_allowed_packet",
  "sql_mode",
  "time_zone",
  "system_time_zone",
  "character_set_server",
  "collation_server",
  "default_storage_engine",
  "read_only",
  "innodb_buffer_pool_size",
];

const STATUS = [
  "Uptime",
  "Threads_connected",
  "Threads_running",
  "Queries",
  "Slow_queries",
  "Aborted_connects",
];

const DEFAULT_PROCESS_LIMIT = 50;

export const serverInfoTool: ToolDefinition = {
  name: "server_info",

  describe(ctx) {
    return {
      name: "server_info",
      description:
        `Read-only diagnostics for a MySQL server: version, a curated set ` +
        `of global variables (max_connections, wait_timeout, sql_mode, ` +
        `time_zone, buffer pool size, ...), key status counters (uptime, ` +
        `threads connected/running, slow queries), and, by default, the ` +
        `current process list from SHOW FULL PROCESSLIST. Use it to answer ` +
        `"what version is this?" and "why is the server busy/slow?" without ` +
        `hand-writing SQL. Safe on read-only connections. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Server info and diagnostics",
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          includeProcessList: {
            type: "boolean",
            description:
              "Include the current process list (SHOW FULL PROCESSLIST). " +
              "Default true.",
            default: true,
          },
          processLimit: {
            type: "number",
            description: `Max process-list rows to return. Default ${DEFAULT_PROCESS_LIMIT}.`,
            default: DEFAULT_PROCESS_LIMIT,
            minimum: 1,
          },
          connection: connectionEnum(ctx),
        },
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const includeProcessList = args.includeProcessList !== false;
    const processLimit =
      typeof args.processLimit === "number" &&
      Number.isInteger(args.processLimit) &&
      args.processLimit >= 1
        ? args.processLimit
        : DEFAULT_PROCESS_LIMIT;

    const connectionName = resolveConnectionName(ctx, args.connection);
    const pool = ctx.pools.getPool(connectionName);

    const [[versionRows], [variableRows], [statusRows]] = await Promise.all([
      pool.query<RowDataPacket[]>("SELECT VERSION() AS version"),
      pool.query<RowDataPacket[]>({
        sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN (?)",
        values: [VARIABLES],
      }),
      pool.query<RowDataPacket[]>({
        sql: "SHOW GLOBAL STATUS WHERE Variable_name IN (?)",
        values: [STATUS],
      }),
    ]);

    const response: Record<string, unknown> = {
      connection: connectionName,
      version: versionRows[0]?.version ?? null,
      variables: toMap(variableRows),
      status: toMap(statusRows),
    };

    if (includeProcessList) {
      const [processRows] = await pool.query<RowDataPacket[]>(
        "SHOW FULL PROCESSLIST",
      );
      const { kept, truncated } = capBySerializedSize(
        processRows.slice(0, processLimit),
        ctx.defaultMaxResponseBytes,
      );
      response.processList = kept;
      response.processCount = processRows.length;
      if (truncated || processRows.length > processLimit) {
        response.processListTruncated = true;
      }
    }

    return response;
  },
};

function toMap(rows: RowDataPacket[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const name = row.Variable_name;
    if (typeof name === "string") out[name] = row.Value;
  }
  return out;
}
