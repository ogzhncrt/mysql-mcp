import { describe, expect, it } from "vitest";

import { describeTableTool } from "../src/tools/describe-table.js";
import { listSchemasTool } from "../src/tools/list-schemas.js";
import { listTablesTool } from "../src/tools/list-tables.js";
import { sampleRowsTool } from "../src/tools/sample-rows.js";
import { serverInfoTool } from "../src/tools/server-info.js";
import { showCreateTableTool } from "../src/tools/show-create-table.js";
import { buildTestContext } from "./helpers/mock-pool.js";

describe("list_schemas", () => {
  it("runs SHOW DATABASES and returns the names", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      { Database: "information_schema" },
      { Database: "myapp" },
    ]);

    const result = (await listSchemasTool.execute({}, ctx)) as Record<
      string,
      unknown
    >;

    expect(ctx.pools.pool.queries[0].sql).toBe("SHOW DATABASES");
    expect(result.count).toBe(2);
    expect(result.schemas).toEqual(["information_schema", "myapp"]);
  });
});

describe("list_tables with database", () => {
  it("targets another schema with a quoted SHOW TABLES FROM", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ Tables_in_other: "widgets" }]);

    await listTablesTool.execute({ database: "other_db" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toBe("SHOW TABLES FROM `other_db`");
  });
});

describe("describe_table / show_create_table with database", () => {
  it("qualifies the table with db.table, both backtick-escaped", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]); // DESCRIBE
    ctx.pools.pool.pushResponse([]); // SHOW INDEXES

    await describeTableTool.execute(
      { table: "users", database: "other_db" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toBe(
      "DESCRIBE `other_db`.`users`",
    );
    expect(ctx.pools.pool.queries[1].sql).toBe(
      "SHOW INDEXES FROM `other_db`.`users`",
    );
  });

  it("show_create_table qualifies with the schema", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ "Create Table": "CREATE TABLE ..." }]);

    await showCreateTableTool.execute(
      { table: "users", database: "other_db" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toBe(
      "SHOW CREATE TABLE `other_db`.`users`",
    );
  });
});

describe("sample_rows", () => {
  it("selects a capped sample from a qualified table", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ id: 1 }, { id: 2 }]);

    const result = (await sampleRowsTool.execute(
      { table: "users", limit: 5 },
      ctx,
    )) as Record<string, unknown>;

    expect(ctx.pools.pool.queries[0].sql).toBe(
      "SELECT * FROM `users` LIMIT 5",
    );
    expect(result.rowCount).toBe(2);
  });

  it("rejects a limit above the maximum", async () => {
    const ctx = buildTestContext();
    await expect(
      sampleRowsTool.execute({ table: "users", limit: 99999 }, ctx),
    ).rejects.toThrow(/limit/);
  });

  it("rejects an invalid table identifier before querying", async () => {
    const ctx = buildTestContext();
    await expect(
      sampleRowsTool.execute({ table: "a`b" }, ctx),
    ).rejects.toThrow(/table/);
    expect(ctx.pools.pool.queries).toHaveLength(0);
  });
});

describe("server_info", () => {
  it("collects version, variables, status, and process list", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ version: "8.0.36" }]);
    ctx.pools.pool.pushResponse([
      { Variable_name: "max_connections", Value: "151" },
    ]);
    ctx.pools.pool.pushResponse([
      { Variable_name: "Uptime", Value: "12345" },
    ]);
    ctx.pools.pool.pushResponse([{ Id: 1, User: "root", Command: "Query" }]);

    const result = (await serverInfoTool.execute({}, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.version).toBe("8.0.36");
    expect(result.variables).toMatchObject({ max_connections: "151" });
    expect(result.status).toMatchObject({ Uptime: "12345" });
    expect(Array.isArray(result.processList)).toBe(true);
  });

  it("skips the process list when includeProcessList is false", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([{ version: "8.0.36" }]);
    ctx.pools.pool.pushResponse([]);
    ctx.pools.pool.pushResponse([]);

    const result = (await serverInfoTool.execute(
      { includeProcessList: false },
      ctx,
    )) as Record<string, unknown>;

    expect(result.processList).toBeUndefined();
    // version + variables + status only; no PROCESSLIST query
    expect(ctx.pools.pool.queries).toHaveLength(3);
    expect(
      ctx.pools.pool.queries.some((q) => q.sql.includes("PROCESSLIST")),
    ).toBe(false);
  });
});
