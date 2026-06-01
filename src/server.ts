import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "./config/types.js";
import {
  listDatabaseResources,
  readDatabaseResource,
} from "./resources/database-resources.js";
import {
  createToolContext,
  dispatchTool,
  listToolDescriptors,
  type ToolContext,
} from "./tools/registry.js";

const SERVER_NAME = "mcp-server-mysql";
const SERVER_VERSION = "1.0.0";

export class DatabaseMcpServer {
  private readonly server: Server;
  private readonly ctx: ToolContext;
  private shuttingDown = false;

  constructor(config: AppConfig) {
    this.ctx = createToolContext(config);
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listToolDescriptors(this.ctx),
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params;
        return dispatchTool(name, args, this.ctx);
      },
    );

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: listDatabaseResources(this.ctx),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const content = readDatabaseResource(request.params.uri, this.ctx);
      return { contents: [content] };
    });
  }

  async run(): Promise<void> {
    this.installShutdownHandlers();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write("mcp-server-mysql running on stdio\n");
  }

  private installShutdownHandlers(): void {
    const shutdown = (signal: string) => {
      void this.shutdown(signal);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    process.stderr.write(`Received ${signal}, shutting down\n`);
    try {
      await this.ctx.pools.closeAll();
    } finally {
      process.exit(0);
    }
  }
}
