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

  it("appends LIMIT on its own line after a trailing comment (regression: 1.2 swallowed it)", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM users -- note" },
      ctx,
    );

    const sql = ctx.pools.pool.queries[0].sql;
    expect(sql).toMatch(/\nLIMIT 100$/);
    // the LIMIT must not share a line with the -- comment
    const lastLine = sql.split("\n").pop() ?? "";
    expect(lastLine).toBe("LIMIT 100");
  });

  it("appends LIMIT after a trailing semicolon + comment", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM users; -- done" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toMatch(/users\nLIMIT 100$/);
  });

  it("still appends outer LIMIT when only a subquery has one (regression: 1.2)", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM (SELECT id FROM t LIMIT 5) x" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toMatch(/\nLIMIT 100$/);
  });

  it("auto-appends LIMIT and the timeout hint to a WITH...SELECT CTE", async () => {
    const ctx = buildTestContext({ defaultQueryTimeoutMs: 4000 });
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "WITH recent AS (SELECT id FROM users) SELECT * FROM recent" },
      ctx,
    );

    const sql = ctx.pools.pool.queries[0].sql;
    expect(sql).toMatch(/\nLIMIT 100$/);
    expect(sql).toContain("/*+ MAX_EXECUTION_TIME(4000) */");
  });

  it("does NOT auto-append LIMIT across a multi-statement batch", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute(
      { query: "SELECT * FROM a; SELECT * FROM b" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).not.toMatch(/LIMIT 100/);
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

  it("allows SHOW CREATE TABLE on read-only (regression: 1.2 false positive)", async () => {
    const ctx = readOnlyContext();
    ctx.pools.pool.pushResponse([]);

    await executeQueryTool.execute({ query: "SHOW CREATE TABLE users" }, ctx);

    expect(ctx.pools.pool.queries).toHaveLength(1);
  });

  it("rejects LOAD DATA / SET GLOBAL / KILL on read-only (1.3 hardening)", async () => {
    for (const query of [
      "LOAD DATA INFILE '/tmp/x' INTO TABLE t",
      "SET GLOBAL max_connections = 1",
      "KILL 1234",
    ]) {
      const ctx = readOnlyContext();
      await expect(
        executeQueryTool.execute({ query }, ctx),
      ).rejects.toThrow(/read-only/i);
      expect(ctx.pools.pool.queries).toHaveLength(0);
    }
  });

  it('returns columns + row arrays with format: "compact"', async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);

    const result = (await executeQueryTool.execute(
      { query: "SELECT id, name FROM users", format: "compact" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([
      [1, "alice"],
      [2, "bob"],
    ]);
    expect(result.rowCount).toBe(2);
  });

  it("truncates rows when the response exceeds maxResponseBytes", async () => {
    const ctx = buildTestContext({ defaultMaxResponseBytes: 1024 });
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      payload: "x".repeat(200),
    }));
    ctx.pools.pool.pushResponse(rows);

    const result = (await executeQueryTool.execute(
      { query: "SELECT * FROM big" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.truncated).toBe(true);
    expect(result.fetchedRowCount).toBe(100);
    expect(result.rowCount).toBeLessThan(100);
    expect((result.rows as unknown[]).length).toBe(result.rowCount);
    expect(result.note).toMatch(/truncated/i);
  });

  it("rejects an unknown format value", async () => {
    const ctx = buildTestContext();
    await expect(
      executeQueryTool.execute({ query: "SELECT 1", format: "csv" }, ctx),
    ).rejects.toThrow(/format/);
  });
});

function readOnlyContext() {
  return buildTestContext({
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
}

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

  it("injects into the main SELECT of a WITH...SELECT CTE", () => {
    expect(
      injectMaxExecutionTime("WITH x AS (SELECT 1) SELECT * FROM x", 3000),
    ).toBe(
      "WITH x AS (SELECT 1) SELECT /*+ MAX_EXECUTION_TIME(3000) */ * FROM x",
    );
  });

  it("injects into the main SELECT of a RECURSIVE / multi-CTE query", () => {
    expect(
      injectMaxExecutionTime(
        "WITH RECURSIVE a AS (SELECT 1 UNION SELECT 2), b (n) AS (SELECT 3) SELECT * FROM a, b",
        100,
      ),
    ).toBe(
      "WITH RECURSIVE a AS (SELECT 1 UNION SELECT 2), b (n) AS (SELECT 3) SELECT /*+ MAX_EXECUTION_TIME(100) */ * FROM a, b",
    );
  });

  it("leaves CTE-disguised writes unchanged (main statement is not SELECT)", () => {
    const sql = "WITH x AS (SELECT 1) INSERT INTO logs SELECT id FROM x";
    expect(injectMaxExecutionTime(sql, 3000)).toBe(sql);
  });
});
