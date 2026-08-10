import { describe, expect, it } from "vitest";

import { listForeignKeysTool } from "../src/tools/list-foreign-keys.js";
import { searchColumnsTool } from "../src/tools/search-columns.js";
import { tableStatsTool } from "../src/tools/table-stats.js";
import { buildTestContext } from "./helpers/mock-pool.js";

describe("table_stats", () => {
  it("queries information_schema scoped to the current database", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      {
        TABLE_NAME: "users",
        TABLE_TYPE: "BASE TABLE",
        ENGINE: "InnoDB",
        TABLE_ROWS: 1200,
        AVG_ROW_LENGTH: 96,
        DATA_LENGTH: 114688,
        INDEX_LENGTH: 49152,
        AUTO_INCREMENT: 1201,
        TABLE_COLLATION: "utf8mb4_0900_ai_ci",
        CREATE_TIME: "2026-01-01 00:00:00",
        UPDATE_TIME: null,
      },
    ]);

    const result = (await tableStatsTool.execute({}, ctx)) as Record<
      string,
      unknown
    >;

    const sql = ctx.pools.pool.queries[0].sql;
    expect(sql).toContain("information_schema.TABLES");
    expect(sql).toContain("TABLE_SCHEMA = DATABASE()");
    expect(result.count).toBe(1);
    expect((result.tables as Array<Record<string, unknown>>)[0]).toMatchObject(
      {
        table: "users",
        engine: "InnoDB",
        approxRows: 1200,
        dataBytes: 114688,
        indexBytes: 49152,
      },
    );
  });

  it("filters by table via a bound parameter", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await tableStatsTool.execute({ table: "orders" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toContain("AND TABLE_NAME = ?");
    expect(ctx.pools.pool.queries[0].values).toEqual(["orders"]);
  });

  it("scopes to another schema via a bound parameter when database is given", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await tableStatsTool.execute({ database: "other_db", table: "orders" }, ctx);

    const query = ctx.pools.pool.queries[0];
    expect(query.sql).toContain("TABLE_SCHEMA = ?");
    expect(query.sql).not.toContain("DATABASE()");
    // schema binding comes first, then the table filter
    expect(query.values).toEqual(["other_db", "orders"]);
  });
});

describe("list_foreign_keys", () => {
  it("groups multi-column constraints", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      {
        CONSTRAINT_NAME: "fk_order_user",
        TABLE_NAME: "orders",
        COLUMN_NAME: "user_id",
        REFERENCED_TABLE_NAME: "users",
        REFERENCED_COLUMN_NAME: "id",
        ORDINAL_POSITION: 1,
        UPDATE_RULE: "CASCADE",
        DELETE_RULE: "RESTRICT",
      },
      {
        CONSTRAINT_NAME: "fk_order_user",
        TABLE_NAME: "orders",
        COLUMN_NAME: "user_org",
        REFERENCED_TABLE_NAME: "users",
        REFERENCED_COLUMN_NAME: "org",
        ORDINAL_POSITION: 2,
        UPDATE_RULE: "CASCADE",
        DELETE_RULE: "RESTRICT",
      },
    ]);

    const result = (await listForeignKeysTool.execute({}, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.count).toBe(1);
    const fk = (result.foreignKeys as Array<Record<string, unknown>>)[0];
    expect(fk.constraint).toBe("fk_order_user");
    expect(fk.table).toBe("orders");
    expect(fk.referencedTable).toBe("users");
    expect(fk.deleteRule).toBe("RESTRICT");
    expect(fk.columns).toEqual([
      { column: "user_id", referencedColumn: "id" },
      { column: "user_org", referencedColumn: "org" },
    ]);
  });

  it("matches both directions when a table is given", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await listForeignKeysTool.execute({ table: "users" }, ctx);

    const query = ctx.pools.pool.queries[0];
    expect(query.sql).toContain(
      "(kcu.TABLE_NAME = ? OR kcu.REFERENCED_TABLE_NAME = ?)",
    );
    expect(query.values).toEqual(["users", "users"]);
  });

  it("scopes to another schema, binding the database before the table", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await listForeignKeysTool.execute(
      { database: "other_db", table: "users" },
      ctx,
    );

    const query = ctx.pools.pool.queries[0];
    expect(query.sql).toContain("kcu.TABLE_SCHEMA = ?");
    expect(query.values).toEqual(["other_db", "users", "users"]);
  });
});

describe("search_columns", () => {
  it("searches column names with an escaped LIKE pattern", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([
      {
        TABLE_NAME: "users",
        COLUMN_NAME: "email",
        COLUMN_TYPE: "varchar(255)",
        IS_NULLABLE: "NO",
        COLUMN_KEY: "UNI",
        COLUMN_DEFAULT: null,
        EXTRA: "",
      },
    ]);

    const result = (await searchColumnsTool.execute(
      { pattern: "email" },
      ctx,
    )) as Record<string, unknown>;

    const query = ctx.pools.pool.queries[0];
    expect(query.sql).toContain("information_schema.COLUMNS");
    expect(query.values).toEqual(["%email%"]);
    expect(result.count).toBe(1);
    expect((result.columns as Array<Record<string, unknown>>)[0]).toMatchObject(
      {
        table: "users",
        column: "email",
        type: "varchar(255)",
        nullable: false,
        key: "UNI",
      },
    );
  });

  it("escapes LIKE wildcards in the pattern with an explicit ESCAPE char", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await searchColumnsTool.execute({ pattern: "100%_done!" }, ctx);

    expect(ctx.pools.pool.queries[0].sql).toContain("ESCAPE '!'");
    expect(ctx.pools.pool.queries[0].values).toEqual(["%100!%!_done!!%"]);
  });

  it("requires a pattern", async () => {
    const ctx = buildTestContext();
    await expect(
      searchColumnsTool.execute({}, ctx),
    ).rejects.toThrow(/pattern/);
  });

  it("scopes to another schema, binding the database before the pattern", async () => {
    const ctx = buildTestContext();
    ctx.pools.pool.pushResponse([]);

    await searchColumnsTool.execute(
      { pattern: "email", database: "other_db" },
      ctx,
    );

    const query = ctx.pools.pool.queries[0];
    expect(query.sql).toContain("TABLE_SCHEMA = ?");
    expect(query.values).toEqual(["other_db", "%email%"]);
  });

  it("rejects an invalid database identifier", async () => {
    const ctx = buildTestContext();
    await expect(
      searchColumnsTool.execute({ pattern: "x", database: "a`b" }, ctx),
    ).rejects.toThrow(/database/);
  });
});
