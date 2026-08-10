import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "../config/types.js";
import {
  DEFAULT_CONNECTION_NAME,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
  MAX_QUERY_LIMIT,
} from "../config/types.js";
import { PoolManager } from "../db/pool-manager.js";
import type { ToolContext, ToolDefinition } from "../lib/context.js";
import { jsonStringify } from "../lib/json.js";

import { executeQueryTool } from "./execute-query.js";
import { explainQueryTool } from "./explain-query.js";
import { listTablesTool } from "./list-tables.js";
import { describeTableTool } from "./describe-table.js";
import { showCreateTableTool } from "./show-create-table.js";
import { getSchemaTool } from "./get-schema.js";
import { listDatabasesTool } from "./list-databases.js";
import { listSchemasTool } from "./list-schemas.js";
import { tableStatsTool } from "./table-stats.js";
import { listForeignKeysTool } from "./list-foreign-keys.js";
import { searchColumnsTool } from "./search-columns.js";
import { sampleRowsTool } from "./sample-rows.js";
import { serverInfoTool } from "./server-info.js";

export type { ToolContext, ToolDefinition } from "../lib/context.js";
export type CallToolResponse = CallToolResult;

const TOOLS: ToolDefinition[] = [
  executeQueryTool,
  explainQueryTool,
  listTablesTool,
  describeTableTool,
  showCreateTableTool,
  getSchemaTool,
  listDatabasesTool,
  listSchemasTool,
  tableStatsTool,
  listForeignKeysTool,
  searchColumnsTool,
  sampleRowsTool,
  serverInfoTool,
];

export function createToolContext(config: AppConfig): ToolContext {
  return {
    config,
    pools: new PoolManager(config.connections),
    defaultConnection:
      config.defaults?.connection ?? DEFAULT_CONNECTION_NAME,
    // Schema already caps this for file configs; clamp again so no other
    // config path can exceed the hard limit.
    defaultQueryLimit: Math.min(
      config.defaults?.queryLimit ?? DEFAULT_QUERY_LIMIT,
      MAX_QUERY_LIMIT,
    ),
    defaultQueryTimeoutMs:
      config.defaults?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    defaultMaxResponseBytes:
      config.defaults?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

export function listToolDescriptors(
  ctx: ToolContext,
): Array<ReturnType<ToolDefinition["describe"]>> {
  return TOOLS.map((tool) => tool.describe(ctx));
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext,
): Promise<CallToolResponse> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return errorResponse(`Unknown tool: ${name}`, name);
  }

  try {
    const result = await tool.execute(args ?? {}, ctx);
    return {
      content: [{ type: "text", text: jsonStringify(result) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, name);
  }
}

function errorResponse(message: string, tool: string): CallToolResponse {
  return {
    content: [
      {
        type: "text",
        text: jsonStringify({ error: message, tool }),
      },
    ],
    isError: true,
  };
}
