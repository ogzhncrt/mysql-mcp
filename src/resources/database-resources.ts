import { DEFAULT_PORT } from "../config/types.js";
import type { ToolContext } from "../tools/registry.js";
import { jsonStringify } from "../tools/registry.js";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

const URI_REGEX = /^database:\/\/(.+)$/;

export function listDatabaseResources(
  ctx: ToolContext,
): ResourceDescriptor[] {
  return ctx.pools.listConnectionNames().map((name) => {
    const conn = ctx.pools.getConfig(name);
    return {
      uri: `database://${name}`,
      name: `${name} (${conn.database})`,
      description: `MySQL connection to ${conn.host}/${conn.database}`,
      mimeType: "application/json",
    };
  });
}

export function readDatabaseResource(
  uri: string,
  ctx: ToolContext,
): ResourceContent {
  const match = URI_REGEX.exec(uri);
  if (!match) {
    throw new Error(
      `Unsupported resource URI "${uri}". Expected "database://<connectionName>".`,
    );
  }
  const name = match[1];
  if (!ctx.pools.hasConnection(name)) {
    throw new Error(
      `Unknown connection "${name}". Available: ${ctx.pools.listConnectionNames().join(", ")}`,
    );
  }

  const conn = ctx.pools.getConfig(name);
  const payload = {
    connectionName: conn.connectionName,
    host: conn.host,
    database: conn.database,
    port: conn.port ?? DEFAULT_PORT,
    readOnly: conn.readOnly === true,
  };

  return {
    uri,
    mimeType: "application/json",
    text: jsonStringify(payload),
  };
}
