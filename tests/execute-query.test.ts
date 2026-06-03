import { describe, expect, it } from "vitest";

import { executeQueryTool, injectMaxExecutionTime } from "../src/tools/execute-query.js";
import { buildTestContext } from "./helpers/mock-pool.js";

describe("execute_query", () => {
  it("auto-appends LIMIT to bare SELECT", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute({ query: "SELECT * FROM users" }, ctx);

    expect(ctx.pools.pool.queries).toHaveLength(1);
    expect(ctx.pools.pool.queries[0].sql).toMatch(/LIMIT 100$/);
  });

  it("does NOT auto-append LIMIT when LIMIT is already present", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM users LIMIT 5" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).not.toMatch(/LIMIT 100/);
    expect(ctx.pools.pool.queries[0].sql).toMatch(/LIMIT 5$/);
  });

  it("ignores LIMIT inside string literals (regression: 1.1 bug)", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM users WHERE note = 'add LIMIT here'" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toMatch(/LIMIT 100\s*$/);
  });

  it("ignores LIMIT inside comments", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM users -- maybe add LIMIT 10 later" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toMatch(/LIMIT 100/);
  });

  it("injects MAX_EXECUTION_TIME hint on SELECT", async () => {
    const ctx = buildTestContext({ defaultQueryTimeoutMs: 5000 });
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute({ query: "SELECT 1" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toContain(
      "/*+ MAX_EXECUTION_TIME(5000) */",
    );
  });

  it("does NOT inject MAX_EXECUTION_TIME on non-SELECT", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse({ affectedRows: 1, insertId: 42 });

    await executeQueryTool.execute(
      { query: "INSERT INTO users (id) VALUES (1)" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).not.toContain("MAX_EXECUTION_TIME");
  });

  it("passes params through to the driver", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      {
        query: "SELECT * FROM users WHERE id = ?",
        params: [42],
      },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].values).toEqual([42]);
  });

  it("rejects writes on read-only connections (incl. CTE writes)", async () => {
    const ctx = buildTestContext({
      connections: [
        {
          connectionName: "prod",
          host: "h",
          user: "u",
          password: "p",
          database: "d",
          readOnly: true,
        },
      ],
      defaultConnection: "prod",
    });

    const result = (await executeQueryTool.execute(
      { query: "WITH x AS (SELECT 1) DELETE FROM users" },
      ctx,
    ).catch((e: Error) => e)) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/read-only/i);
    expect(ctx.pools.pool.queries).toHaveLength(0);
  });

  it("shapes INSERT response with insertId as string (bigint-safe)", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse({ affectedRows: 1, insertId: 999 });

    const result = (await executeQueryTool.execute(
      { query: "INSERT INTO users (id) VALUES (1)" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.queryType).toBe("INSERT");
    expect(result.affectedRows).toBe(1);
    expect(result.insertId).toBe("999");
  });

  it("rejects limit above MAX_QUERY_LIMIT", async () => {
    const ctx = buildTestContext();
    await expect(
      executeQueryTool.execute({ query: "SELECT 1", limit: 99999999 }, ctx),
    ).rejects.toThrow(/<= 10000/);
  });
});

describe("injectMaxExecutionTime", () => {
  it("injects after a leading SELECT", () => {
    expect(injectMaxExecutionTime("SELECT 1", 3000)).toBe(
      "SELECT /*+ MAX_EXECUTION_TIME(3000) */ 1",
    );
  });

  it("skips block comments before SELECT", () => {
    expect(
      injectMaxExecutionTime("/* report */ SELECT 1", 3000),
    ).toBe("/* report */ SELECT /*+ MAX_EXECUTION_TIME(3000) */ 1");
  });

  it("returns query unchanged for non-SELECT", () => {
    expect(injectMaxExecutionTime("INSERT INTO t VALUES (1)", 3000)).toBe(
      "INSERT INTO t VALUES (1)",
    );
  });

  it("returns query unchanged for CTE queries (known limitation)", () => {
    const sql = "WITH x AS (SELECT 1) SELECT * FROM x";
    expect(injectMaxExecutionTime(sql, 3000)).toBe(sql);
  });
});
