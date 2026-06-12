import type { AppConfig } from "../config/types.js";
import type { PoolManager } from "../db/pool-manager.js";

export interface ToolContext {
  config: AppConfig;
  pools: PoolManager;
  defaultConnection: string;
  defaultQueryLimit: number;
  defaultQueryTimeoutMs: number;
  defaultMaxResponseBytes: number;
}

/**
 * MCP tool annotations (spec 2025-03-26). Hints for clients about tool
 * behavior — e.g. Cursor and Claude use readOnlyHint to relax approval
 * prompts for safe tools.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  describe(ctx: ToolContext): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: ToolAnnotations;
  };
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown>;
}
