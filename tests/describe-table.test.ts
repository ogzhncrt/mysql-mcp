import { describe, expect, it } from "vitest";

import { describeTableTool } from "../src/tools/describe-table.js";
import { showCreateTableTool } from "../src/tools/show-create-table.js";
import { buildTestContext } from "./helpers/mock-pool.js";

describe("describe_table", () => {
  it("runs DESCRIBE and SHOW INDEXES with backtick-escaped name", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ Field: "id", Type: "int" }]);
    ctx.pools.pool.pushResponse([{ Key_name: "PRIMARY" }]);

    const result = (await describeTableTool.execute(
      { table: "users" },
      ctx,
    )) as Record<string, unknown>;

    const sqls = ctx.pools.pool.queries.map((q) => q.sql).sort();
    expect(sqls).toEqual(["DESCRIBE `users`", "SHOW INDEXES FROM `users`"]);
    expect(result.table).toBe("users");
  });

  it("accepts identifiers with $ and -", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);
    ctx.pools.pool.pushResponse([]);

    await expect(
      describeTableTool.execute({ table: "users_v2$archive" }, ctx),
    ).resolves.toBeDefined();
  });

  it("rejects table names with backticks", async () => {
    const ctx = buildTestContext();
    await expect(
      describeTableTool.execute({ table: "users`; DROP TABLE x; --" }, ctx),
    ).rejects.toThrow(/table/);
    expect(ctx.pools.pool.queries).toHaveLength(0);
  });
});

describe("show_create_table", () => {
  it("returns the Create Table string", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      { Table: "users", "Create Table": "CREATE TABLE `users` (...)" },
    ]);

    const result = (await showCreateTableTool.execute(
      { table: "users" },
      ctx,
    )) as Record<string, unknown>;

    expect(ctx.pools.pool.queries[0].sql).toBe("SHOW CREATE TABLE `users`");
    expect(result.createStatement).toBe("CREATE TABLE `users` (...)");
  });

  it("falls back to Create View when querying a view", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      { View: "v_users", "Create View": "CREATE VIEW `v_users` AS SELECT 1" },
    ]);

    const result = (await showCreateTableTool.execute(
      { table: "v_users" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.createStatement).toBe(
      "CREATE VIEW `v_users` AS SELECT 1",
    );
  });
});
