import { DEFAULT_PORT } from "../config/types.js";

import {
  connectionSummary,
  type ToolDefinition,
} from "./registry.js";

export const listDatabasesTool: ToolDefinition = {
  name: "list_databases",

  describe(ctx) {
    return {
      name: "list_databases",
      description:
        `List configured MySQL connections (without passwords). ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  },

  async execute(_args, ctx) {
    const databases = ctx.pools.listConnectionNames().map((name) => {
      const conn = ctx.pools.getConfig(name);
      return {
        name: conn.connectionName,
        host: conn.host,
        database: conn.database,
        port: conn.port ?? DEFAULT_PORT,
        readOnly: conn.readOnly === true,
      };
    });

    return { databases, count: databases.length };
  },
};
