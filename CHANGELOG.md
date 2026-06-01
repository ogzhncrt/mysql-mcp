# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
