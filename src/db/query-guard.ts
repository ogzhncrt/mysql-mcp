import type { ConnectionConfig } from "../config/types.js";

const WRITE_PREFIXES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "RENAME",
  "REPLACE",
  "GRANT",
  "REVOKE",
  "LOCK",
  "UNLOCK",
] as const;

export function normalizeForPrefix(sql: string): string {
  return sql.trim().toUpperCase();
}

export function isWriteQuery(sql: string): boolean {
  const normalized = normalizeForPrefix(sql);
  return WRITE_PREFIXES.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix} `) ||
      normalized.startsWith(`${prefix}\n`) ||
      normalized.startsWith(`${prefix}\t`),
  );
}

export function isSelectQuery(sql: string): boolean {
  const normalized = normalizeForPrefix(sql);
  return (
    normalized === "SELECT" ||
    normalized.startsWith("SELECT ") ||
    normalized.startsWith("SELECT\n") ||
    normalized.startsWith("SELECT\t")
  );
}

export class ReadOnlyViolationError extends Error {
  constructor(connectionName: string) {
    super(
      `Connection "${connectionName}" is read-only. ` +
        `Only SELECT and other read operations are allowed.`,
    );
    this.name = "ReadOnlyViolationError";
  }
}

export function assertCanExecute(
  connection: ConnectionConfig,
  sql: string,
): void {
  if (connection.readOnly === true && isWriteQuery(sql)) {
    throw new ReadOnlyViolationError(connection.connectionName);
  }
}
