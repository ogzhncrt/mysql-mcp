import type { ConnectionConfig } from "../config/types.js";

const WRITE_KEYWORDS = [
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
  "CALL",
] as const;

const WRITE_KEYWORD_REGEX = new RegExp(
  `\\b(?:${WRITE_KEYWORDS.join("|")})\\b`,
  "i",
);

export function normalizeForPrefix(sql: string): string {
  return sql.trim().toUpperCase();
}

/**
 * Strip MySQL comments and string literals so keyword detection can't be
 * defeated by `SELECT 'DELETE FROM users'` or `-- DELETE FROM users`.
 *
 * Removes:
 *   - block comments: /* ... *\/
 *   - line comments: -- to end-of-line, # to end-of-line
 *   - single- and double-quoted string literals (with backslash and
 *     doubled-quote escapes)
 *
 * Backticks (identifier quoting) are intentionally kept so that
 * `\`DELETE\`` as an identifier name is still visible as a token; the
 * keyword regex uses \b boundaries so backtick-wrapped identifiers won't
 * match anyway.
 */
export function stripCommentsAndStrings(sql: string): string {
  let s = sql;
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/--[^\n]*/g, " ");
  s = s.replace(/(^|\s)#[^\n]*/g, "$1 ");

  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          if (s[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function isWriteQuery(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql);
  return WRITE_KEYWORD_REGEX.test(stripped);
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
