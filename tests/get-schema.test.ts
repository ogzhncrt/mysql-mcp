import { describe, expect, it } from "vitest";

import { getSchemaTool } from "../src/tools/get-schema.js";
import { buildTestContext } from "./helpers/mock-pool.js";

type Schema = Record<string, unknown>;
type Table = Record<string, unknown>;

/**
 * get_schema fires its queries with Promise.all in a fixed order: tables,
 * columns, then foreign keys. The mock pool returns queued responses in
 * call order, so queue them in that same order.
 */
function queueFullSchema(
  ctx: ReturnType<typeof buildTestContext>,
  opts: {
    tables: unknown[];
    columns: unknown[];
    foreignKeys: unknown[];
  },
): void {
  ctx.pools.pool.pushResponse(opts.tables);
  ctx.pools.pool.pushResponse(opts.columns);
  ctx.pools.pool.pushResponse(opts.foreignKeys);
}

describe("get_schema", () => {
  it("builds a compact map of tables, columns, and foreign keys", async () => {
    const ctx = buildTestContext();
    queueFullSchema(ctx, {
      tables: [
        { TABLE_NAME: "users", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" },
        { TABLE_NAME: "orders", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" },
      ],
      columns: [
        {
          TABLE_NAME: "users",
          COLUMN_NAME: "id",
          COLUMN_TYPE: "bigint unsigned",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          EXTRA: "auto_increment",
        },
        {
          TABLE_NAME: "users",
          COLUMN_NAME: "email",
          COLUMN_TYPE: "varchar(255)",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "UNI",
          EXTRA: "",
        },
        {
          TABLE_NAME: "orders",
          COLUMN_NAME: "user_id",
          COLUMN_TYPE: "bigint unsigned",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "MUL",
          EXTRA: "",
        },
      ],
      foreignKeys: [
        {
          TABLE_NAME: "orders",
          CONSTRAINT_NAME: "fk_orders_user",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id",
          UPDATE_RULE: "CASCADE",
          DELETE_RULE: "RESTRICT",
        },
      ],
    });

    const result = (await getSchemaTool.execute({}, ctx)) as Schema;

    expect(result.tableCount).toBe(2);
    expect(result.database).toBe("test_db");
    const tables = result.tables as Table[];
    expect(tables).toHaveLength(2);

    const users = tables.find((t) => t.name === "users") as Table;
    expect(users.type).toBe("table");
    expect(users.engine).toBe("InnoDB");
    expect(users.columns).toEqual([
      {
        name: "id",
        type: "bigint unsigned",
        nullable: false,
        key: "PRI",
        extra: "auto_increment",
      },
      { name: "email", type: "varchar(255)", nullable: false, key: "UNI" },
    ]);

    const orders = tables.find((t) => t.name === "orders") as Table;
    expect(orders.foreignKeys).toEqual([
      {
        constraint: "fk_orders_user",
        referencedTable: "users",
        columns: [{ column: "user_id", referencedColumn: "id" }],
        updateRule: "CASCADE",
        deleteRule: "RESTRICT",
      },
    ]);
    // No foreign keys on users, so the key is omitted entirely.
    expect(users.foreignKeys).toBeUndefined();
  });

  it("groups composite foreign keys under one constraint", async () => {
    const ctx = buildTestContext();
    queueFullSchema(ctx, {
      tables: [
        { TABLE_NAME: "memberships", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" },
      ],
      columns: [],
      foreignKeys: [
        {
          TABLE_NAME: "memberships",
          CONSTRAINT_NAME: "fk_member",
          COLUMN_NAME: "org_id",
          REFERENCED_TABLE_NAME: "orgs",
          REFERENCED_COLUMN_NAME: "id",
          UPDATE_RULE: "CASCADE",
          DELETE_RULE: "CASCADE",
        },
        {
          TABLE_NAME: "memberships",
          CONSTRAINT_NAME: "fk_member",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_NAME: "orgs",
          REFERENCED_COLUMN_NAME: "owner_id",
          UPDATE_RULE: "CASCADE",
          DELETE_RULE: "CASCADE",
        },
      ],
    });

    const result = (await getSchemaTool.execute({}, ctx)) as Schema;
    const table = (result.tables as Table[])[0];
    const fks = table.foreignKeys as Array<Record<string, unknown>>;

    expect(fks).toHaveLength(1);
    expect(fks[0].columns).toEqual([
      { column: "org_id", referencedColumn: "id" },
      { column: "user_id", referencedColumn: "owner_id" },
    ]);
  });

  it("marks views and reports their type", async () => {
    const ctx = buildTestContext();
    queueFullSchema(ctx, {
      tables: [
        { TABLE_NAME: "active_users", TABLE_TYPE: "VIEW", ENGINE: null },
      ],
      columns: [
        {
          TABLE_NAME: "active_users",
          COLUMN_NAME: "id",
          COLUMN_TYPE: "bigint",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "",
          EXTRA: "",
        },
      ],
      foreignKeys: [],
    });

    const result = (await getSchemaTool.execute({}, ctx)) as Schema;
    const view = (result.tables as Table[])[0];
    expect(view.type).toBe("view");
    expect(view.engine).toBeNull();
  });

  it("skips the columns query and omits columns when includeColumns is false", async () => {
    const ctx = buildTestContext();
    // Only two queries run (tables, foreign keys) when columns are excluded.
    ctx.pools.pool.pushResponse([
      { TABLE_NAME: "users", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" },
    ]);
    ctx.pools.pool.pushResponse([]);

    const result = (await getSchemaTool.execute(
      { includeColumns: false },
      ctx,
    )) as Schema;

    expect(ctx.pools.pool.queries).toHaveLength(2);
    expect(
      ctx.pools.pool.queries.some((q) =>
        q.sql.includes("information_schema.COLUMNS"),
      ),
    ).toBe(false);
    expect((result.tables as Table[])[0].columns).toBeUndefined();
  });

  it("scopes every query to the requested tables via a bound array", async () => {
    const ctx = buildTestContext();
    queueFullSchema(ctx, { tables: [], columns: [], foreignKeys: [] });

    await getSchemaTool.execute({ tables: ["users", "orders"] }, ctx);

    expect(ctx.pools.pool.queries).toHaveLength(3);
    for (const q of ctx.pools.pool.queries) {
      expect(q.sql).toContain("IN (?)");
      expect(q.values).toEqual([["users", "orders"]]);
    }
  });

  it("truncates trailing tables when the map exceeds maxResponseBytes", async () => {
    const ctx = buildTestContext();
    const manyTables = Array.from({ length: 200 }, (_, i) => ({
      TABLE_NAME: `table_${i}`,
      TABLE_TYPE: "BASE TABLE",
      ENGINE: "InnoDB",
    }));
    queueFullSchema(ctx, {
      tables: manyTables,
      columns: [],
      foreignKeys: [],
    });

    const result = (await getSchemaTool.execute(
      { maxResponseBytes: 1024 },
      ctx,
    )) as Schema;

    expect(result.truncated).toBe(true);
    expect(result.tableCount).toBe(200);
    expect(result.returnedTableCount).toBeLessThan(200);
    expect((result.tables as Table[]).length).toBe(result.returnedTableCount);
    expect(result.note).toMatch(/truncated/i);
  });

  it("rejects an empty or malformed tables filter", async () => {
    const ctx = buildTestContext();
    await expect(
      getSchemaTool.execute({ tables: [] }, ctx),
    ).rejects.toThrow(/must not be empty/);

    await expect(
      getSchemaTool.execute({ tables: ["ok", 42] }, ctx),
    ).rejects.toThrow(/tables\[1\]/);
  });
});
