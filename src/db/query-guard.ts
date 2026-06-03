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

/**
 * True iff the SQL's first keyword (after stripping leading comments and
 * whitespace) is SELECT. CTE queries (`WITH ... SELECT ...`) return false —
 * detecting them correctly requires tracking parenthesis depth across the
 * WITH clause, which we don't do.
 */
export function isSelectQuery(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql);
  const trimmed = stripped.trimStart();
  return /^SELECT(\s|\(|$)/i.test(trimmed);
}

/**
 * True iff the SQL contains a top-level LIMIT clause. String literals and
 * comments are stripped first so `WHERE note = 'add LIMIT here'` and
 * `-- LIMIT 10` do not trigger a false positive.
 */
export function containsLimitClause(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql);
  return /\bLIMIT\b/i.test(stripped);
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
