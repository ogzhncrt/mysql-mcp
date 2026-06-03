import { describe, expect, it } from "vitest";

import { explainQueryTool } from "../src/tools/explain-query.js";
import { buildTestContext } from "./helpers/mock-pool.js";

describe("explain_query", () => {
  it("prepends EXPLAIN with TRADITIONAL format by default", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await explainQueryTool.execute({ query: "SELECT * FROM users" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toBe("EXPLAIN SELECT * FROM users");
  });

  it("uses FORMAT=JSON when requested", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await explainQueryTool.execute(
      { query: "SELECT 1", format: "JSON" },
      ctx,
    );

    expect(ctx.pools.pool.queries[0].sql).toBe(
      "EXPLAIN FORMAT=JSON SELECT 1",
    );
  });

  it("strips trailing semicolons", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await explainQueryTool.execute({ query: "SELECT 1;" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toBe("EXPLAIN SELECT 1");
  });

  it("rejects queries starting with ANALYZE", async () => {
    const ctx = buildTestContext();
    await expect(
      explainQueryTool.execute({ query: "ANALYZE SELECT 1" }, ctx),
    ).rejects.toThrow(/ANALYZE/);
    expect(ctx.pools.pool.queries).toHaveLength(0);
  });

  it("rejects unknown format values", async () => {
    const ctx = buildTestContext();
    await expect(
      explainQueryTool.execute({ query: "SELECT 1", format: "YAML" }, ctx),
    ).rejects.toThrow(/format/);
  });
});
