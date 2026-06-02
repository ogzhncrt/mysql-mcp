import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "../config/types.js";
import {
  DEFAULT_CONNECTION_NAME,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "../config/types.js";
import { PoolManager } from "../db/pool-manager.js";

import { executeQueryTool } from "./execute-query.js";
import { listTablesTool } from "./list-tables.js";
import { describeTableTool } from "./describe-table.js";
import { listDatabasesTool } from "./list-databases.js";
import { explainQueryTool } from "./explain-query.js";

export interface ToolContext {
  config: AppConfig;
  pools: PoolManager;
  defaultConnection: string;
  defaultQueryLimit: number;
  defaultQueryTimeoutMs: number;
}

export interface ToolDefinition {
  name: string;
  describe(ctx: ToolContext): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown>;
}

export type CallToolResponse = CallToolResult;

const TOOLS: ToolDefinition[] = [
  executeQueryTool,
  explainQueryTool,
  listTablesTool,
  describeTableTool,
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

export function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2,
  );
}

export function connectionEnum(ctx: ToolContext) {
  return {
    type: "string",
    enum: ctx.pools.listConnectionNames(),
    description: `Connection name. Defaults to "${ctx.defaultConnection}".`,
    default: ctx.defaultConnection,
  } as const;
}

export function connectionSummary(ctx: ToolContext): string {
  return ctx.pools
    .listConnectionNames()
    .map((name) => {
      const conn = ctx.pools.getConfig(name);
      const ro = conn.readOnly === true ? " (READ-ONLY)" : "";
      return `${name}${ro}`;
    })
    .join(", ");
}

export function resolveConnectionName(
  ctx: ToolContext,
  requested: unknown,
): string {
  if (requested === undefined || requested === null || requested === "") {
    return ctx.defaultConnection;
  }
  if (typeof requested !== "string") {
    throw new Error(
      `"connection" must be a string (got ${typeof requested})`,
    );
  }
  if (!ctx.pools.hasConnection(requested)) {
    throw new Error(
      `Unknown connection "${requested}". Available: ${ctx.pools.listConnectionNames().join(", ")}`,
    );
  }
  return requested;
}
