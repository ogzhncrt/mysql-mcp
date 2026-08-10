import type { ConnectionConfig } from "../config/types.js";

/**
 * Statement starters that are pure reads. The read-only guard is
 * default-deny: any statement whose first keyword is not in this set is
 * rejected. This closes the gaps a keyword blocklist can't cover
 * (LOAD DATA, SET GLOBAL, KILL, FLUSH, RESET MASTER, PURGE, OPTIMIZE,
 * DO SLEEP(...), BEGIN/COMMIT, USE, PREPARE, ...).
 */
const READ_STARTERS = new Set([
  "SELECT",
  "WITH",
  "TABLE",
  "VALUES",
  "SHOW",
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "HELP",
  "CHECKSUM",
]);

/** EXPLAIN / DESCRIBE / DESC are synonyms; all support the ANALYZE form. */
const EXPLAIN_STARTERS = new Set(["EXPLAIN", "DESCRIBE", "DESC"]);

/**
 * Write verbs that can be smuggled into a statement that *starts* with a
 * read keyword, e.g. `WITH x AS (...) DELETE FROM t` or
 * `SELECT ... FOR UPDATE`. Notes:
 *   - INSERT uses a negative lookahead so the INSERT(str,pos,len,newstr)
 *     string function stays usable; an INSERT *statement* is never
 *     immediately followed by "(".
 *   - REPLACE and TRUNCATE are absent on purpose: as statement verbs they
 *     are caught by the starter allowlist, while REPLACE(...) and
 *     TRUNCATE(...) are common SQL functions inside SELECTs.
 */
const EMBEDDED_WRITE_REGEX = new RegExp(
  "\\b(?:INSERT(?!\\s*\\()|UPDATE|DELETE|DROP|CREATE|ALTER|RENAME|GRANT|REVOKE|CALL|LOAD|KILL)\\b",
  "i",
);

/** SELECT ... INTO OUTFILE/DUMPFILE writes files on the server host. */
const INTO_FILE_REGEX = /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i;

/**
 * Mask everything that is not SQL structure, preserving string length so
 * character positions in the output map 1:1 to the input:
 *   - comments (block, `--`, `#`) become spaces
 *   - string literals ('...', "...") and backtick-quoted identifiers
 *     become runs of "?", non-space so trailing-trim logic never cuts
 *     into a literal, non-word so \b keyword regexes can't match inside
 *
 * Masking backtick identifiers is what prevents false positives like
 * `SELECT \`update\` FROM audit` being treated as a write: \b matches
 * right after a backtick, so keeping identifier text visible is unsafe.
 *
 * Single pass, so comment markers inside string literals (and quotes
 * inside comments) are handled correctly.
 */
export function stripCommentsAndStrings(sql: string): string {
  const len = sql.length;
  const out: string[] = new Array(len);
  let i = 0;
  while (i < len) {
    const c = sql[i];

    if (c === "/" && sql[i + 1] === "*") {
      // MySQL executable comments (`/*! ... */` and versioned
      // `/*!50000 ... */`) are executed by the server, so their contents
      // must stay visible to the read-only guard. Blank only the opening
      // marker and any version digits; the inner SQL is then processed
      // normally (strings masked, keywords detectable). The trailing "*/"
      // is left as-is, which is harmless: it has no word characters, so it
      // can neither form nor hide a keyword.
      if (sql[i + 2] === "!") {
        let j = i + 3;
        while (j < len && sql[j] >= "0" && sql[j] <= "9") j++;
        for (let k = i; k < j; k++) out[k] = " ";
        i = j;
        continue;
      }
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? len : close + 2;
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }

    // MySQL only starts a "--" comment when the dashes are followed by
    // whitespace/control or end-of-input; "1--1" is arithmetic, not a
    // comment. Blanking "--" unconditionally would hide a statement the
    // server actually runs (e.g. `SELECT 1--1;DELETE FROM t` with
    // multipleStatements enabled).
    const isDashComment =
      c === "-" &&
      sql[i + 1] === "-" &&
      (i + 2 >= len || /\s/.test(sql[i + 2]));
    if (isDashComment || c === "#") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? len : nl; // keep the newline itself
      for (let k = i; k < end; k++) out[k] = " ";
      i = end;
      continue;
    }

    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < len) {
        if (quote !== "`" && sql[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      for (let k = i; k < j; k++) out[k] = "?";
      i = j;
      continue;
    }

    out[i] = c;
    i++;
  }
  return out.join("");
}

/**
 * Split masked SQL on statement separators. Safe as a plain split because
 * any ";" inside a string literal has already been masked away.
 */
export function splitStatements(maskedSql: string): string[] {
  return maskedSql.split(";");
}

/**
 * True iff the SQL contains more than one non-empty statement. Only
 * meaningful when `multipleStatements` is enabled; used to keep the
 * auto-LIMIT from binding to just the last statement of a batch.
 */
export function isMultiStatement(sql: string): boolean {
  const masked = stripCommentsAndStrings(sql);
  return splitStatements(masked).filter((s) => s.trim() !== "").length > 1;
}

function firstKeyword(maskedStmt: string): string | null {
  const match = /^[\s(]*([A-Za-z_]+)/.exec(maskedStmt);
  return match ? match[1].toUpperCase() : null;
}

/**
 * True iff a single masked statement is a pure read. Default-deny:
 * unknown or missing starters return false.
 */
export function isReadStatement(maskedStmt: string): boolean {
  const trimmed = maskedStmt.trim();
  if (trimmed === "") return true; // empty segment from a trailing ";"

  const keyword = firstKeyword(trimmed);
  if (!keyword || !READ_STARTERS.has(keyword)) return false;

  if (EXPLAIN_STARTERS.has(keyword)) {
    // EXPLAIN ANALYZE (and DESC/DESCRIBE ANALYZE) actually executes the
    // statement on MySQL 8.0.18+, so it is not a read.
    const rest = trimmed.replace(/^[\s(]*[A-Za-z_]+\s*/, "");
    return !/^ANALYZE\b/i.test(rest);
  }

  if (
    keyword === "SELECT" ||
    keyword === "WITH" ||
    keyword === "TABLE" ||
    keyword === "VALUES"
  ) {
    if (EMBEDDED_WRITE_REGEX.test(trimmed)) return false;
    if (INTO_FILE_REGEX.test(trimmed)) return false;
  }

  return true;
}

/**
 * True iff the SQL is anything other than a pure read. Multi-statement
 * strings (only executable when `multipleStatements` is enabled) are
 * checked per statement.
 *
 * Known intentional over-blocks on read-only connections:
 *   - `SELECT ... FOR UPDATE` (acquires exclusive row locks)
 *   - the INSERT(...) string function when written with a space before "("
 */
export function isWriteQuery(sql: string): boolean {
  const masked = stripCommentsAndStrings(sql);
  return splitStatements(masked).some((stmt) => !isReadStatement(stmt));
}

/**
 * True iff the SQL's first keyword (after stripping leading comments and
 * whitespace) is SELECT. CTE queries (`WITH ... SELECT ...`) return false.
 * Detecting them correctly requires tracking parenthesis depth across the
 * WITH clause, which this helper does not do.
 */
export function isSelectQuery(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql);
  const trimmed = stripped.trimStart();
  return /^SELECT(\s|\(|$)/i.test(trimmed);
}

/** Reads the keyword/identifier at `i`, or null if `i` is not on a word. */
function readWord(
  masked: string,
  i: number,
): { word: string; end: number } | null {
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(masked.slice(i));
  if (!match) return null;
  return { word: match[0].toUpperCase(), end: i + match[0].length };
}

function skipWhitespace(masked: string, i: number): number {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

/** Index just past the ")" matching the "(" at `open`, or -1. */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Starting at the beginning of one CTE definition, find the "(" that opens
 * its `AS (...)` subquery, or -1. Depth tracking skips an optional column
 * list, as in `cte (a, b) AS (...)`, so we land on the subquery paren.
 */
function findCteSubqueryParen(masked: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < masked.length) {
    const c = masked[i];
    if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && /[A-Za-z_]/.test(c)) {
      const word = readWord(masked, i);
      if (word && word.word === "AS") {
        const j = skipWhitespace(masked, word.end);
        return masked[j] === "(" ? j : -1;
      }
      i = word ? word.end : i + 1;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * For a query that produces rows through a top-level SELECT (either a
 * bare `SELECT ...` or a `WITH ... SELECT ...` CTE whose *main* statement
 * is a SELECT), returns the index in `sql` immediately after that SELECT
 * keyword, where an optimizer hint can be injected. Returns null for
 * writes, CTE-disguised writes (`WITH x AS (...) INSERT ...`), and
 * non-SELECT reads (TABLE/VALUES/SHOW/...).
 *
 * Runs on masked SQL so comments, string literals, and backtick
 * identifiers can't fool keyword detection; masking preserves length, so
 * the returned index maps 1:1 onto the original string.
 */
export function findOuterSelectEnd(sql: string): number | null {
  const masked = stripCommentsAndStrings(sql);
  let i = skipWhitespace(masked, 0);

  const first = readWord(masked, i);
  if (!first) return null;
  if (first.word === "SELECT") return first.end;
  if (first.word !== "WITH") return null;

  i = skipWhitespace(masked, first.end);
  const recursive = readWord(masked, i);
  if (recursive && recursive.word === "RECURSIVE") {
    i = skipWhitespace(masked, recursive.end);
  }

  // Walk the comma-separated CTE definitions to the start of the main query.
  for (;;) {
    const open = findCteSubqueryParen(masked, i);
    if (open === -1) return null;
    const close = matchParen(masked, open);
    if (close === -1) return null;
    i = skipWhitespace(masked, close);
    if (masked[i] === ",") {
      i = skipWhitespace(masked, i + 1);
      continue;
    }
    break;
  }

  const main = readWord(masked, i);
  return main && main.word === "SELECT" ? main.end : null;
}

/**
 * Leading keyword of the *main* statement, resolving past a leading
 * `WITH ... ` CTE chain so `WITH x AS (...) INSERT ...` reports INSERT
 * rather than WITH. Runs on masked SQL; returns null when no keyword is
 * found. Used for labeling result messages, not for the read-only guard.
 */
export function mainStatementKeyword(sql: string): string | null {
  const masked = stripCommentsAndStrings(sql);
  let i = skipWhitespace(masked, 0);

  const first = readWord(masked, i);
  if (!first) return null;
  if (first.word !== "WITH") return first.word;

  i = skipWhitespace(masked, first.end);
  const recursive = readWord(masked, i);
  if (recursive && recursive.word === "RECURSIVE") {
    i = skipWhitespace(masked, recursive.end);
  }

  for (;;) {
    const open = findCteSubqueryParen(masked, i);
    if (open === -1) return null;
    const close = matchParen(masked, open);
    if (close === -1) return null;
    i = skipWhitespace(masked, close);
    if (masked[i] === ",") {
      i = skipWhitespace(masked, i + 1);
      continue;
    }
    break;
  }

  const main = readWord(masked, i);
  return main ? main.word : null;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * True iff the SQL contains a LIMIT clause at parenthesis depth 0.
 * Comments and string literals are masked first, so `-- LIMIT 10` and
 * `WHERE note = 'add LIMIT here'` don't trigger false positives, and a
 * LIMIT inside a subquery, like `SELECT * FROM (SELECT 1 LIMIT 5) x`, no
 * longer suppresses the outer auto-LIMIT.
 */
export function containsTopLevelLimit(sql: string): boolean {
  const masked = stripCommentsAndStrings(sql);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && (c === "L" || c === "l")) {
      const boundaryBefore = i === 0 || !IDENT_CHAR.test(masked[i - 1]);
      const word = masked.slice(i, i + 6);
      if (boundaryBefore && /^LIMIT(?:[^A-Za-z0-9_$]|$)/i.test(word)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns the SQL with trailing whitespace, trailing comments, and
 * statement-terminating semicolons removed. Computed on the masked text,
 * so a ";" or "--" inside a string literal is never treated as trailing.
 */
export function trimTrailingNoise(sql: string): string {
  const masked = stripCommentsAndStrings(sql);
  let i = masked.length - 1;
  while (i >= 0 && (masked[i] === ";" || /\s/.test(masked[i]))) i--;
  return sql.slice(0, i + 1);
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
