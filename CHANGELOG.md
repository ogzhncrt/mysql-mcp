# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  SQL injection — prefer this over interpolating values into `query`.
- **`explain_query` tool.** Runs `EXPLAIN [FORMAT=JSON|TREE] <query>`
  without executing the underlying statement. Lets agents inspect the
  plan, index usage, and estimated row counts on read-only production
  connections. Rejects queries that start with `ANALYZE` (which would
  cause `EXPLAIN ANALYZE` — actually executes on MySQL 8.0+).
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
