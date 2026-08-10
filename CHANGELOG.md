# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-10

### Security

- **Read-only guard no longer bypassed by MySQL executable comments.**
  MySQL *executes* the contents of `/*! ... */` and versioned
  `/*!50000 ... */` comments, but the guard masked them like ordinary
  comments, so `/*! DELETE FROM users */` and
  `SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */` passed the read-only check
  and ran on the server. The masker now blanks only the comment markers and
  keeps the inner SQL visible, so the write/keyword scan sees the real
  statement. No `multipleStatements` needed to trigger the old hole.
- **`--` is treated as a comment only when followed by whitespace/EOL**, as
  MySQL requires. Previously `SELECT 1--1;DELETE FROM t` masked the trailing
  `DELETE` away and (with `multipleStatements` enabled) the server ran it.

### Added

- **Multi-database support.** `list_tables`, `get_schema`, `table_stats`,
  `search_columns`, `list_foreign_keys`, `describe_table`, `show_create_table`,
  and the new `sample_rows` accept an optional `database` argument to inspect
  another schema on the same server. `information_schema` queries bind the
  schema as a parameter; identifier-based statements use a backtick-escaped
  `` `db`.`table` `` reference.
- **`list_schemas` tool.** `SHOW DATABASES`, so an agent can discover which
  schemas exist before targeting one with `database`.
- **`sample_rows` tool.** `SELECT * FROM <table> LIMIT n` (default 10, max
  1000) to preview real data without hand-writing SQL. Read-only-safe.
- **`server_info` tool.** Read-only diagnostics: server version, curated
  global variables, key status counters, and (by default) the current
  process list. Answers "what version?" and "why is it busy?".
- **`mysql://` connection URLs.** Set `MYSQL_URL` (e.g.
  `mysql://user:pass@host:3306/db`) instead of the four discrete `MYSQL_*`
  vars. User/password/database are URL-decoded; `?ssl=true|false|amazon-rds`
  and the `mysqls://` scheme select TLS (`MYSQL_SSL` still overrides).
- **Pagination for `execute_query`.** An optional `offset` produces
  `LIMIT n OFFSET m` when the server adds the LIMIT (bare SELECT /
  `WITH...SELECT` without an explicit LIMIT).

### Changed

- **`execute_query` result labeling.** `queryType` now resolves the *main*
  statement verb, so `WITH x AS (...) INSERT ...` reports `INSERT` (not
  `WITH`), and `REPLACE` gets its own affected-rows message.
- **Per-query timeouts are capped** at `MAX_QUERY_TIMEOUT_MS` (1 hour) in
  `execute_query` and `explain_query`, so a single call can't pin a pooled
  connection open indefinitely.
- **Pool queue is bounded** by default (`queueLimit: 20`, configurable per
  connection) instead of unbounded, so a burst of calls fails fast rather
  than piling up without limit.

### Tests

- 126 tests, up from 100: executable-comment and `--` bypass regressions,
  `mainStatementKeyword`, `MYSQL_URL` parsing, `offset` pagination,
  `REPLACE`/CTE result labeling, the timeout cap, multi-database scoping,
  and the new `list_schemas`, `sample_rows`, and `server_info` tools.

## [1.4.0] - 2026-06-24

### Added

- **`get_schema` tool.** Returns a compact map of the entire database in a
  single call: every table and view with its columns (name, type,
  nullability, key) and the foreign keys that connect them. This lets an
  agent understand an unfamiliar schema and write correct, well-joined SQL
  without describing tables one at a time. Built for large databases: three
  `information_schema` scans total (no per-table round trips), an optional
  `tables` filter, an `includeColumns: false` mode for a relationship-only
  overview, and the same `maxResponseBytes` cap as `execute_query` (trailing
  tables are dropped with `truncated: true` when the map does not all fit).

### Changed

- The response size cap used by `execute_query` is now a shared
  `capBySerializedSize` helper in `lib/json`, reused by `get_schema` so both
  truncate oversized output identically.
- Removed em-dash and en-dash characters from source comments, tool
  descriptions, and docs in favor of plain ASCII punctuation.

### Tests

- 100 tests, up from 93: schema mapping, composite foreign-key grouping,
  view detection, the `tables` filter, `includeColumns: false`, truncation,
  and filter validation.

## [1.3.1] - 2026-06-24

### Fixed

- **`WITH ... SELECT` CTEs now get the auto-LIMIT and the server-side
  timeout.** Previously only bare `SELECT`s were auto-LIMITed and given the
  `MAX_EXECUTION_TIME` optimizer hint; a CTE like
  `WITH recent AS (...) SELECT * FROM recent` ran **unbounded** and its
  `timeoutMs` degraded to a client-side socket close while the server kept
  churning. A new `findOuterSelectEnd` parses the CTE list (paren-depth
  aware, `RECURSIVE`/multi-CTE/column-list aware) to locate the main SELECT,
  so the limit and hint now apply. CTE-disguised writes
  (`WITH x AS (...) INSERT ...`) are still correctly left untouched, and
  remain rejected on read-only connections by the unchanged write guard.
- **Auto-LIMIT no longer mis-binds in multi-statement batches.** With
  `multipleStatements: true`, `SELECT * FROM a; SELECT * FROM b` got a
  trailing `LIMIT` that bound only to the *last* statement, leaving the
  first uncapped. Auto-LIMIT is now skipped when more than one statement is
  present.
- **`search_columns` LIKE escaping is mode-independent.** It used a
  backslash escape, which is unreliable across the `NO_BACKSLASH_ESCAPES`
  SQL mode and the driver's own backslash doubling, so a search for
  `tenant_id` could let `_` act as a wildcard. It now declares an explicit
  `ESCAPE '!'` clause and escapes `!`, `%`, and `_`.

### Tests

- 93 tests, up from 83: CTE limit/hint injection, RECURSIVE/multi-CTE
  parsing, CTE-write rejection, multi-statement auto-LIMIT skip, and the
  explicit LIKE ESCAPE behavior.

## [1.3.0] - 2026-06-12

### Security

- **Read-only guard is now a default-deny allowlist.** The 1.x guard was a
  keyword *blocklist*, and blocklists have holes: `LOAD DATA INFILE`,
  `SET GLOBAL`, `KILL`, `FLUSH`, `RESET MASTER`, `PURGE BINARY LOGS`,
  `OPTIMIZE TABLE`, `DO SLEEP(...)`, `HANDLER`, `PREPARE`, and transaction
  control all executed on `readOnly: true` connections. Now only statements
  starting with `SELECT`, `WITH`, `TABLE`, `VALUES`, `SHOW`, `EXPLAIN`,
  `DESCRIBE`/`DESC`, `HELP`, or `CHECKSUM` are allowed, and
  `SELECT`/`WITH`/`TABLE`/`VALUES` bodies are still scanned for embedded
  write verbs (CTE writes) plus `INTO OUTFILE`/`INTO DUMPFILE`.
  Behavior change: statements like `SET`, `BEGIN`/`COMMIT`, `USE`, and
  `SELECT ... FOR UPDATE` (write locks) are now rejected on read-only
  connections. With `multipleStatements: true`, every `;`-separated
  statement is checked, not just the first.
- **`EXPLAIN ANALYZE` bypass closed.** `explain_query` rejected a leading
  `ANALYZE` but not `/*c*/ ANALYZE ...`: MySQL allows comments between
  tokens, so the resulting `EXPLAIN /*c*/ ANALYZE ...` actually *executed*
  the statement on 8.0.18+. The check is now comment-aware, and the guard
  also catches `EXPLAIN ANALYZE` / `DESC ANALYZE` passed to
  `execute_query` on read-only connections.
- **`explain_query` rejects multi-statement input.** With
  `multipleStatements: true`, `explain_query("SELECT 1; DROP TABLE x")`
  executed the `DROP` with no read-only check. `;`-separated statements
  are now rejected (semicolons inside string literals are fine).
- **`defaults.queryLimit` is clamped to the hard max.** A config with
  `queryLimit: 50000` previously defeated the documented `MAX_QUERY_LIMIT`
  of 10,000 whenever the `limit` arg was omitted.

### Fixed

- **Read-only guard false positives.** The keyword scan matched inside
  backtick-quoted identifiers (the old comment claiming `\b` prevented
  this was wrong: `\b` matches right after a backtick). These pure reads
  were all rejected on read-only connections and now work:
  ``SELECT `update` FROM audit``, `SHOW CREATE TABLE t`,
  `EXPLAIN UPDATE t SET ...`, `SELECT REPLACE(name,'a','b')`,
  `SELECT INSERT('abcd',2,2,'xy')`, `SELECT TRUNCATE(2.5,1)`.
  Backtick-quoted identifiers are now masked before keyword scanning, and
  the `REPLACE()`/`INSERT()`/`TRUNCATE()` SQL functions are recognized.
- **Auto-LIMIT was silently swallowed by trailing comments.**
  `SELECT * FROM t -- note` became `... -- note LIMIT 100`: the LIMIT
  landed inside the comment and the query ran unbounded. The limit is now
  appended on its own line after trailing comments/semicolons are removed
  (position-safe: a `;` or `--` inside a trailing string literal is never
  mistaken for noise).
- **A `LIMIT` inside a subquery no longer suppresses the outer auto-LIMIT.**
  `SELECT * FROM (SELECT 1 LIMIT 5) x` previously got no outer cap; LIMIT
  detection is now parenthesis-depth-aware.
- **Comment/string stripping is a single pass.** Comment markers inside
  string literals (e.g. `SELECT '-- not a comment'`) were previously
  mangled by the regex-based comment pass running before string removal.
- **BIGINT values above 2^53 no longer lose precision.** Pools now set
  `supportBigNumbers: true`; oversized values come back as strings.
- **DATE/DATETIME/TIMESTAMP are returned as plain strings**
  (`dateStrings: true`) instead of JS `Date` objects, which were getting
  timezone-shifted during JSON serialization.

### Added

- **Three schema tools.** `table_stats` (per-table size, approximate row
  count, engine, auto-increment from `information_schema.TABLES`),
  `list_foreign_keys` (relationships, grouped per constraint, both
  directions when a table is given), and `search_columns` (find a column
  name across all tables, case-insensitive substring).
- **MCP tool annotations.** Every tool now advertises
  `readOnlyHint`/`destructiveHint`/`idempotentHint`, so MCP clients can
  relax approval prompts for safe tools. `execute_query` reports
  `readOnlyHint: true` when every configured connection is read-only.
- **`format: "compact"` on `execute_query`.** Returns
  `{ columns: [...], rows: [[...]] }` instead of one object per row,
  much smaller payloads for wide result sets.
- **Response size cap.** New `maxResponseBytes` arg on `execute_query`
  (default 1,000,000, configurable via `defaults.maxResponseBytes`).
  Oversized result sets are truncated with `truncated: true`, the fetched
  row count, and a note suggesting a narrower query.
- `execute_query`'s description now warns that session state
  (transactions, `SET`, `USE`, temp tables) does not persist between
  calls, since each call may run on a different pooled connection.

### Tests

- 83 tests, up from 49: allowlist bypass/false-positive matrix, masking
  position-preservation, top-level LIMIT detection, trailing-noise
  trimming, compact format, truncation, and the three new tools.

## [1.2.0] - 2026-06-03

### Fixed

- **Auto-LIMIT no longer fooled by string literals or comments.** Previously
  `SELECT * FROM t WHERE note = 'add LIMIT here'` skipped the auto-LIMIT
  because the naive `\bLIMIT\b` regex matched inside the string. Now the
  comment/string-stripping pass from the write-guard is reused for LIMIT
  detection, so the auto-LIMIT applies whenever it should.
- **`isSelectQuery` is now comment-aware.** A query like
  `/* hint */ SELECT * FROM t` previously failed the SELECT check, so it
  got no auto-LIMIT and no `MAX_EXECUTION_TIME` hint. Fixed by stripping
  leading comments before the prefix test.
- **`timeoutMs` actually cancels SELECTs server-side now.** v1.1's
  `timeoutMs` only closed the client socket; the query kept running on
  the MySQL server, holding locks and consuming CPU. v1.2 injects a
  `/*+ MAX_EXECUTION_TIME(N) */` optimizer hint into SELECT queries so
  MySQL 5.7.4+ cancels them server-side. Non-SELECT statements still fall
  back to client-side socket close (documented behavior: MySQL's
  `MAX_EXECUTION_TIME` only applies to SELECT).
- **`describe_table` rejected legitimate identifiers and was vulnerable
  to backtick injection.** Old regex `/^[a-zA-Z0-9_]+$/` blocked
  `users_v2$archive`, `my-table`, and unicode identifiers, all valid in
  MySQL. New regex accepts everything except control chars and backticks
  (up to 64 chars, MySQL's limit). Backticks are now also properly
  escaped (doubled) in the wrapping quotes, as defense-in-depth.

### Added

- **`show_create_table` tool.** Returns the full `CREATE TABLE` statement
  including column types, defaults, indexes, foreign keys, engine, and
  charset. More complete than `describe_table` when reasoning about
  schema. Also handles views (returns `CREATE VIEW`).
- **`--check` startup mode.** Loads config, pings every connection with
  `SELECT 1`, prints a per-connection status report to stderr, and exits
  with non-zero status if any connection fails. Useful for validating
  config before wiring the server into an MCP client.
- **`connections[].multipleStatements` config flag.** Opt-in. Off by
  default; enabling it lets a single SQL injection vector turn one query
  into many, so it's not for general use.

### Changed

- **Codebase reorganized.** Shared helpers moved from `tools/registry.ts`
  to a new `src/lib/` directory (`json.ts`, `args.ts`, `connections.ts`,
  `identifiers.ts`, `context.ts`). `registry.ts` is now a pure dispatch
  module. No behavior change; cleaner internal boundaries.
- **Source maps excluded from the npm tarball.** Saves ~14 kB without
  losing any user-facing functionality (no original sources were shipped
  alongside the maps anyway, so they only produced orphan path
  references in stack traces). Add `dist/**/*.map` back via `.npmignore`
  if you need them.
- **Per-connection `queryTimeoutMs`** now flows through to the new
  `MAX_EXECUTION_TIME` hint, not just the client-side timeout.

### Tests

- Added tool-handler tests with a mocked pool (49 tests, up from 28),
  covering: auto-LIMIT regression cases (string/comment), MAX_EXECUTION_TIME
  injection, parameterized queries, INSERT response shape, read-only
  guard with CTEs, EXPLAIN format selection, ANALYZE rejection,
  identifier validation, and SHOW CREATE TABLE behavior.

## [1.1.0] - 2026-06-02

> **First npm release.** Published as `mysql-mcp-toolkit`. The names
> `mcp-server-mysql`, `mysql-mcp`, and `mysql-mcp-server` are all
> owned by unrelated projects on the registry; `mysql-mcp-toolkit`
> was the next-best-available name that's still discoverable for the
> obvious search terms.

### Added

- **SSL/TLS support.** New `connections[].ssl` field accepts `true`,
  `false`, the literal `"Amazon RDS"` preset, or a full mysql2 SSL
  options object (`{ ca, cert, key, rejectUnauthorized, ... }`).
  Environment fallback via `MYSQL_SSL=true|false|amazon-rds`. Unblocks
  managed MySQL (RDS, Aurora, PlanetScale, Cloud SQL, DigitalOcean).
- **Parameterized queries.** `execute_query` and `explain_query` now
  accept an optional `params: any[]`. Driver-side escaping prevents
  SQL injection; prefer this over interpolating values into `query`.
- **`explain_query` tool.** Runs `EXPLAIN [FORMAT=JSON|TREE] <query>`
  without executing the underlying statement. Lets agents inspect the
  plan, index usage, and estimated row counts on read-only production
  connections. Rejects queries that start with `ANALYZE` (which would
  cause `EXPLAIN ANALYZE`, which actually executes on MySQL 8.0+).
- **Per-query timeout.** New `defaults.queryTimeoutMs` (default
  `30000`) and per-connection `queryTimeoutMs` override, plus a
  per-call `timeoutMs` arg on `execute_query` and `explain_query`.
  Environment fallback via `MYSQL_QUERY_TIMEOUT_MS`.
- **`--version` flag.** Prints the package version to stdout and exits.
- Hard `MAX_QUERY_LIMIT` of `10000` on `execute_query`'s `limit` arg.

### Changed

- **Read-only guard is now comment- and string-literal-aware.**
  Previously a CTE like `WITH foo AS (SELECT 1) DELETE FROM users`
  bypassed the guard because it started with `WITH`. Now strips block
  comments, line comments (`--`, `#`), and quoted string literals
  before keyword matching, so writes anywhere in the statement are
  detected. Also adds `CALL` to the blocked keyword list to prevent
  arbitrary stored-procedure execution on read-only connections.
- Server now reports its package version (instead of a hardcoded
  string) in the MCP `serverInfo` response.

### Removed

- Internal `CallToolResponse` shim with `[key: string]: unknown` index
  signature; now uses `CallToolResult` from the SDK directly.

## [1.0.0] - 2026-06-01

### Added

- Initial public release.
- MCP server over stdio with four tools: `execute_query`, `list_tables`,
  `describe_table`, `list_databases`.
- One MCP resource per configured connection (`database://<name>`).
- JSON config file with multi-connection support and Zod validation.
- Single-connection bootstrap from `MYSQL_*` environment variables when
  no config file is found.
- Placeholder rejection: any connection field still containing `your-`
  is filtered out at load time.
- Read-only enforcement: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`,
  `ALTER`, `TRUNCATE`, `RENAME`, `REPLACE`, `GRANT`, `REVOKE`, `LOCK`,
  `UNLOCK` are rejected on connections with `readOnly: true`.
- Auto `LIMIT` appended to bare `SELECT` queries (default 100, configurable
  per request or via `defaults.queryLimit`).
- `mcp-server-mysql init [--output <path>]` for generating a starter
  config from the bundled `config.example.json`.
- `mcp-server-mysql --help` and `--config <path>` CLI flags.
- Vitest test suite covering config loading and the read-only query guard.
