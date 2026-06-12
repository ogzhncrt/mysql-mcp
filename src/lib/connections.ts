import type { ToolContext } from "./context.js";

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

export function allConnectionsReadOnly(ctx: ToolContext): boolean {
  return ctx.pools
    .listConnectionNames()
    .every((name) => ctx.pools.getConfig(name).readOnly === true);
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
