import { assertValidIdentifier, escapeIdentifier } from "./identifiers.js";

/**
 * Resolves an optional `database` / schema argument. Returns null when the
 * caller did not specify one (meaning "use the connection's default schema,
 * i.e. `DATABASE()`"), or the validated identifier otherwise.
 */
export function resolveOptionalDatabase(
  value: unknown,
  field = "database",
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`"${field}" must be a string when provided`);
  }
  assertValidIdentifier(value, field);
  return value;
}

/**
 * The SQL expression and bound values for scoping an information_schema
 * query to a schema. When a database is given it is bound as a parameter
 * (`?`), never interpolated; otherwise it falls back to `DATABASE()`, the
 * schema the connection is attached to.
 */
export function schemaScope(database: string | null): {
  expr: string;
  values: string[];
} {
  return database
    ? { expr: "?", values: [database] }
    : { expr: "DATABASE()", values: [] };
}

/**
 * A safely-quoted `db`.`table` (or just `table`) reference for statements
 * like DESCRIBE / SHOW CREATE TABLE that take an identifier rather than a
 * bound parameter. Both identifiers are backtick-escaped.
 */
export function qualifiedName(
  table: string,
  database: string | null,
): string {
  return database
    ? `${escapeIdentifier(database)}.${escapeIdentifier(table)}`
    : escapeIdentifier(table);
}
