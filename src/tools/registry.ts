import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "../config/types.js";
import {
  DEFAULT_CONNECTION_NAME,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "../config/types.js";
import { PoolManager } from "../db/pool-manager.js";
import type { ToolContext, ToolDefinition } from "../lib/context.js";
import { jsonStringify } from "../lib/json.js";

import { executeQueryTool } from "./execute-query.js";
import { explainQueryTool } from "./explain-query.js";
import { listTablesTool } from "./list-tables.js";
import { describeTableTool } from "./describe-table.js";
import { showCreateTableTool } from "./show-create-table.js";
import { listDatabasesTool } from "./list-databases.js";

export type { ToolContext, ToolDefinition } from "../lib/context.js";
export type CallToolResponse = CallToolResult;

const TOOLS: ToolDefinition[] = [
  executeQueryTool,
  explainQueryTool,
  listTablesTool,
  describeTableTool,
  showCreateTableTool,
  listDatabasesTool,
];

export function createToolContext(config: AppConfig): ToolContext {
  return {
    config,
    pools: new PoolManager(config.connections),
    defaultConnection:
      config.defaults?.connection ?? DEFAULT_CONNECTION_NAME,
    defaultQueryLimit:
      config.defaults?.queryLimit ?? DEFAULT_QUERY_LIMIT,
    defaultQueryTimeoutMs:
      config.defaults?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
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
