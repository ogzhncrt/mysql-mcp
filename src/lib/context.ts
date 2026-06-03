import type { AppConfig } from "../config/types.js";
import type { PoolManager } from "../db/pool-manager.js";

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
