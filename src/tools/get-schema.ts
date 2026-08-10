import type { RowDataPacket } from "mysql2";
import type { Pool } from "mysql2/promise";

import { resolvePositiveInt } from "../lib/args.js";
import {
  connectionEnum,
  connectionSummary,
  resolveConnectionName,
} from "../lib/connections.js";
import type { ToolDefinition } from "../lib/context.js";
import {
  resolveOptionalDatabase,
  schemaScope,
} from "../lib/database.js";
import { capBySerializedSize } from "../lib/json.js";

/**
 * One indexed scan of information_schema per concept (tables, columns,
 * foreign keys), each scoped to the current database. Three queries total
 * regardless of how many tables exist, which keeps this cheap on databases
 * with thousands of tables (no per-table round trips).
 */
const TABLES_SQL = `
SELECT TABLE_NAME, TABLE_TYPE, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
`.trim();

const COLUMNS_SQL = `
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
`.trim();

const FOREIGN_KEYS_SQL = `
SELECT
  kcu.TABLE_NAME,
  kcu.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.REFERENCED_TABLE_NAME,
  kcu.REFERENCED_COLUMN_NAME,
  rc.UPDATE_RULE,
  rc.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
 AND rc.TABLE_NAME = kcu.TABLE_NAME
WHERE kcu.TABLE_SCHEMA = DATABASE()
  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
`.trim();

interface SchemaColumn {
  name: unknown;
  type: unknown;
  nullable: boolean;
  key?: unknown;
  extra?: unknown;
}

interface SchemaForeignKey {
  constraint: string;
  referencedTable: string;
  columns: Array<{ column: string; referencedColumn: string }>;
  updateRule: string;
  deleteRule: string;
}

interface SchemaTable {
  name: string;
  type: "table" | "view";
  engine: unknown;
  columns?: SchemaColumn[];
  foreignKeys?: SchemaForeignKey[];
}

export const getSchemaTool: ToolDefinition = {
  name: "get_schema",

  describe(ctx) {
    return {
      name: "get_schema",
      description:
        `Return a compact map of the whole database in one call: every ` +
        `table and view, its columns (name, type, nullability, key), and the ` +
        `foreign keys that connect tables. Use this first to understand an ` +
        `unfamiliar schema and write correct, well-joined SQL without ` +
        `describing tables one at a time. Pass "tables" to scope to a few ` +
        `tables, or "includeColumns": false for a relationship-only overview ` +
        `on very large databases. Output is capped by "maxResponseBytes" and ` +
        `reports "truncated" when it does not all fit. ` +
        `Configured connections: ${connectionSummary(ctx)}.`,
      annotations: {
        title: "Get database schema",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            description:
              "Optional list of table names to restrict the map to. When " +
              "omitted, every table and view in the database is included.",
            items: { type: "string" },
          },
          includeColumns: {
            type: "boolean",
            description:
              "Include per-column detail (default true). Set false for a " +
              "lighter, relationship-only map on very large schemas.",
            default: true,
          },
          database: {
            type: "string",
            description:
              "Optional schema to inspect. Defaults to the connection's " +
              "own database. Use to map another schema on the same server.",
          },
          connection: connectionEnum(ctx),
          maxResponseBytes: {
            type: "number",
            description:
              `Approximate cap on the serialized size of the returned tables. ` +
              `Default ${ctx.defaultMaxResponseBytes}. When exceeded, trailing ` +
              `tables are dropped and "truncated" is set.`,
            default: ctx.defaultMaxResponseBytes,
            minimum: 1024,
          },
        },
        additionalProperties: false,
      },
    };
  },

  async execute(args, ctx) {
    const tables = resolveTablesFilter(args.tables);
    const database = resolveOptionalDatabase(args.database);
    const includeColumns = resolveBoolean(
      args.includeColumns,
      "includeColumns",
      true,
    );
    const maxResponseBytes = resolvePositiveInt(
      args.maxResponseBytes,
      ctx.defaultMaxResponseBytes,
      { field: "maxResponseBytes", min: 1024 },
    );

    const connectionName = resolveConnectionName(ctx, args.connection);
    const connection = ctx.pools.getConfig(connectionName);
    const pool = ctx.pools.getPool(connectionName);
    const scope = schemaScope(database);

    const [tableRows, columnRows, fkRows] = await Promise.all([
      query(pool, withFilter(TABLES_SQL, scope, tables, "TABLE_NAME"), scope, tables),
      includeColumns
        ? query(pool, withFilter(COLUMNS_SQL, scope, tables, "TABLE_NAME"), scope, tables)
        : Promise.resolve([] as RowDataPacket[]),
      query(
        pool,
        withFilter(FOREIGN_KEYS_SQL, scope, tables, "kcu.TABLE_NAME"),
        scope,
        tables,
      ),
    ]);

    const built = buildSchema(tableRows, columnRows, fkRows, includeColumns);
    const { kept, truncated } = capBySerializedSize(built, maxResponseBytes);

    const response: Record<string, unknown> = {
      connection: connectionName,
      database: database ?? connection.database,
      tableCount: built.length,
      tables: kept,
    };

    if (truncated) {
      response.truncated = true;
      response.returnedTableCount = kept.length;
      response.note =
        `Schema truncated: ${kept.length} of ${built.length} tables fit within ` +
        `maxResponseBytes=${maxResponseBytes}. Pass "tables" to scope to ` +
        `specific tables, set "includeColumns": false, or raise ` +
        `"maxResponseBytes".`;
    }

    return response;
  },
};

/**
 * Appends a `<column> IN (?)` filter when table names are given. The list
 * is bound as a single array parameter, which mysql2 expands safely, so no
 * identifier interpolation reaches the SQL string.
 */
function withFilter(
  baseSql: string,
  scope: { expr: string; values: string[] },
  tables: string[] | null,
  column: string,
): string {
  const ordering =
    column === "kcu.TABLE_NAME"
      ? "\nORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"
      : "\nORDER BY TABLE_NAME, ORDINAL_POSITION";
  const scoped =
    scope.expr === "DATABASE()"
      ? baseSql
      : baseSql.replace("DATABASE()", scope.expr);
  const filter = tables ? `\n  AND ${column} IN (?)` : "";
  return `${scoped}${filter}${ordering}`;
}

async function query(
  pool: Pool,
  sql: string,
  scope: { expr: string; values: string[] },
  tables: string[] | null,
): Promise<RowDataPacket[]> {
  const values = [...scope.values, ...(tables ? [tables] : [])];
  const arg = values.length > 0 ? { sql, values } : { sql };
  const [rows] = await pool.query<RowDataPacket[]>(arg);
  return rows;
}

function buildSchema(
  tableRows: RowDataPacket[],
  columnRows: RowDataPacket[],
  fkRows: RowDataPacket[],
  includeColumns: boolean,
): SchemaTable[] {
  const tables = new Map<string, SchemaTable>();
  for (const row of tableRows) {
    const name = String(row.TABLE_NAME);
    const isView = String(row.TABLE_TYPE ?? "").includes("VIEW");
    const table: SchemaTable = {
      name,
      type: isView ? "view" : "table",
      engine: row.ENGINE ?? null,
    };
    if (includeColumns) table.columns = [];
    tables.set(name, table);
  }

  if (includeColumns) {
    for (const row of columnRows) {
      const table = tables.get(String(row.TABLE_NAME));
      if (!table?.columns) continue;
      const column: SchemaColumn = {
        name: row.COLUMN_NAME,
        type: row.COLUMN_TYPE,
        nullable: row.IS_NULLABLE === "YES",
      };
      if (row.COLUMN_KEY) column.key = row.COLUMN_KEY;
      if (row.EXTRA) column.extra = row.EXTRA;
      table.columns.push(column);
    }
  }

  const fkByTable = groupForeignKeys(fkRows);
  for (const [name, fks] of fkByTable) {
    const table = tables.get(name);
    if (table) table.foreignKeys = fks;
  }

  return [...tables.values()];
}

/** Groups foreign-key rows per table, then per constraint (composite keys). */
function groupForeignKeys(
  fkRows: RowDataPacket[],
): Map<string, SchemaForeignKey[]> {
  const byTable = new Map<string, Map<string, SchemaForeignKey>>();
  for (const row of fkRows) {
    const tableName = String(row.TABLE_NAME);
    let constraints = byTable.get(tableName);
    if (!constraints) {
      constraints = new Map();
      byTable.set(tableName, constraints);
    }
    const constraintName = String(row.CONSTRAINT_NAME);
    let fk = constraints.get(constraintName);
    if (!fk) {
      fk = {
        constraint: constraintName,
        referencedTable: String(row.REFERENCED_TABLE_NAME),
        columns: [],
        updateRule: String(row.UPDATE_RULE),
        deleteRule: String(row.DELETE_RULE),
      };
      constraints.set(constraintName, fk);
    }
    fk.columns.push({
      column: String(row.COLUMN_NAME),
      referencedColumn: String(row.REFERENCED_COLUMN_NAME),
    });
  }

  const result = new Map<string, SchemaForeignKey[]>();
  for (const [tableName, constraints] of byTable) {
    result.set(tableName, [...constraints.values()]);
  }
  return result;
}

function resolveTablesFilter(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error('"tables" must be an array of table names when provided');
  }
  if (value.length === 0) {
    throw new Error('"tables" must not be empty when provided');
  }
  return value.map((name, i) => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`"tables[${i}]" must be a non-empty string`);
    }
    return name;
  });
}

function resolveBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`"${field}" must be a boolean`);
  }
  return value;
}
