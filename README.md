# mcp-server-mysql

[![npm](https://img.shields.io/npm/v/mysql-mcp-toolkit.svg)](https://www.npmjs.com/package/mysql-mcp-toolkit)

A Model Context Protocol (MCP) server for MySQL. Lets Cursor and other MCP
clients list tables, describe schema, and run SQL against any MySQL database
you configure, over stdio, with read-only protection for production
connections.

Published as **`mysql-mcp-toolkit`** on npm.

## Quick start (config file)

1. Generate a starter config:
   ```bash
   npx -y mysql-mcp-toolkit init
   # writes ~/.config/mcp-server-mysql/config.json
   ```
2. Replace the placeholder credentials in that file. Any field still
   containing `your-` is treated as a placeholder and the connection is
   rejected at startup.
3. Add the server to Cursor's `~/.cursor/mcp.json`:

   ```json
   {
     "mcpServers": {
       "mysql": {
         "command": "npx",
         "args": [
           "-y",
           "mysql-mcp-toolkit@latest",
           "--config",
           "/absolute/path/to/config.json"
         ]
       }
     }
   }
   ```

   The `@latest` tag matters; see [Updating](#updating). Without it, npx
   caches the first version it installs and keeps reusing it.

4. Restart Cursor. You should see `mysql` show up under MCP tools.

## Quick start (env vars only)

If you only need one connection, skip the config file entirely:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "mysql-mcp-toolkit@latest"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASSWORD": "secret",
        "MYSQL_DATABASE": "myapp",
        "MYSQL_READ_ONLY": "true"
      }
    }
  }
}
```

Or supply a single connection URL instead of the four discrete variables:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "mysql-mcp-toolkit@latest"],
      "env": {
        "MYSQL_URL": "mysql://root:secret@127.0.0.1:3306/myapp",
        "MYSQL_READ_ONLY": "true"
      }
    }
  }
}
```

User, password, and database in the URL are URL-decoded, so reserved
characters (e.g. `@` or `/` in a password) can be percent-encoded. Add
`?ssl=true|false|amazon-rds` or use the `mysqls://` scheme to enable TLS
(`MYSQL_SSL` still overrides). `MYSQL_CONNECTION_NAME`, `MYSQL_READ_ONLY`,
and `MYSQL_QUERY_TIMEOUT_MS` apply to either form.

## Updating

`npx` caches each package spec under `~/.npm/_npx/<hash>/`. If your `mcp.json`
points at `mysql-mcp-toolkit` with no version tag, npx installs whatever is
current on the first run and **keeps reusing that cached copy forever**,
even after new versions ship to npm. That's why the examples above pin
`@latest`: it forces npx to resolve against the registry on every spawn, so
new releases get picked up the next time Cursor restarts the server.

| You want…                            | Use this in `mcp.json`              | Update behavior                          |
| ------------------------------------ | ----------------------------------- | ---------------------------------------- |
| Always run the newest release        | `mysql-mcp-toolkit@latest`          | Auto-updates on Cursor restart           |
| Reproducible pin to a known version  | `mysql-mcp-toolkit@1.2.0`           | Manual: edit `mcp.json` on each upgrade |
| Force-refresh an unpinned cache once | `mysql-mcp-toolkit` (no tag)        | `rm -rf ~/.npm/_npx` before restart      |

After any of these, **restart Cursor** to respawn the MCP child process.
Verify the upgrade worked by checking the tool list: `table_stats`,
`list_foreign_keys`, and `search_columns` arrived in 1.3.0, so seeing them
in Cursor's MCP panel confirms you're current.

## Tools

| Tool                | What it does                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_query`     | Run any SQL. Supports `params` for `?` placeholders, `format: objects\|compact`, and `maxResponseBytes` truncation. Bare `SELECT`s and `WITH … SELECT` CTEs get an auto `LIMIT` (max 10,000) and a `MAX_EXECUTION_TIME` optimizer hint so `timeoutMs` cancels the query **server-side** on MySQL 5.7.4+.           |
| `explain_query`     | `EXPLAIN` a statement without executing it. Supports `format: TRADITIONAL\|JSON\|TREE` and `params`. Safe on read-only connections. Rejects `EXPLAIN ANALYZE` (which executes) and multi-statement input.                                                                                |
| `list_tables`       | `SHOW TABLES` on the chosen connection.                                                                                                                                                                                                                                                  |
| `describe_table`    | `DESCRIBE <table>` + `SHOW INDEXES FROM <table>`. Identifier must be 1-64 chars and contain no backticks or control characters (dollar signs, hyphens, and unicode letters are fine).                                                                                                    |
| `show_create_table` | Returns the full `CREATE TABLE` statement: column types, defaults, indexes, foreign keys, engine, charset. Also works on views (returns `CREATE VIEW`).                                                                                                                                 |
| `get_schema`        | One-call map of the whole database: every table and view with its columns (name, type, nullability, key) and foreign keys. Scope with `tables`, or pass `includeColumns: false` for a relationship-only overview on large schemas. Output is capped by `maxResponseBytes`.               |
| `table_stats`       | Per-table size and row statistics from `information_schema.TABLES`: approximate row count, data/index bytes, engine, collation, auto-increment. Optional `table` filter; sorted largest-first.                                                                                           |
| `list_foreign_keys` | Foreign key relationships in the database, grouped per constraint (multi-column keys included), with update/delete rules. Pass `table` to get both directions: FKs on the table and FKs referencing it.                                                                                 |
| `search_columns`    | Find columns by name across every table (case-insensitive substring, max 500 matches). Returns table, type, nullability, and key info.                                                                                                                                                   |
| `sample_rows`       | Preview a few rows from a table (`SELECT * … LIMIT n`, default 10, max 1000) to see real data shape without hand-writing SQL. Read-only-safe.                                                                                                                                            |
| `list_databases`    | Lists configured connections (host, database, port, read-only flag, ssl flag). Never includes passwords.                                                                                                                                                                                |
| `list_schemas`      | `SHOW DATABASES` — the schemas visible to the connection's user. Use a returned name as the `database` argument to the schema tools to inspect another schema on the same server.                                                                                                        |
| `server_info`       | Read-only diagnostics: server version, curated global variables, key status counters, and (by default) the current process list (`SHOW FULL PROCESSLIST`).                                                                                                                              |

Every schema tool (`list_tables`, `describe_table`, `show_create_table`,
`get_schema`, `table_stats`, `list_foreign_keys`, `search_columns`,
`sample_rows`) accepts an optional `database` argument to inspect a schema
other than the one the connection is attached to. Use `list_schemas` to
discover the available names.

All tools advertise [MCP tool annotations](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations)
(`readOnlyHint`, `destructiveHint`, `idempotentHint`), so clients can relax
approval prompts for the safe ones.

### Read-only enforcement

Connections with `readOnly: true` use a **default-deny allowlist**: only
statements starting with `SELECT`, `WITH`, `TABLE`, `VALUES`, `SHOW`,
`EXPLAIN`, `DESCRIBE`/`DESC`, `HELP`, or `CHECKSUM` are accepted, and
`SELECT`/`WITH` bodies are additionally scanned for embedded writes (CTE
writes like `WITH x AS (...) DELETE FROM t`, `INTO OUTFILE`/`DUMPFILE`,
`FOR UPDATE` locks). Everything else, including `LOAD DATA`, `SET`,
`KILL`, `FLUSH`, `EXPLAIN ANALYZE` (which executes), and transaction
control, is rejected before any SQL leaves the process. Detection is
comment-, string-literal-, and backtick-identifier-aware, so neither
`/* DELETE */` comments nor a column named `` `update` `` confuse it.
MySQL *executable* comments (`/*! ... */`, `/*!50000 ... */`), whose
contents the server actually runs, are inspected rather than ignored, and
`--` is only treated as a comment when followed by whitespace — so
`/*! DELETE FROM t */` and `SELECT 1--1;DELETE FROM t` are both rejected.

Each tool accepts an optional `connection` argument. If omitted, the default
from `defaults.connection` (or the literal `"default"`) is used. Tools that
run user-supplied SQL also accept an optional `timeoutMs` (defaults to the
connection's `queryTimeoutMs`, then `defaults.queryTimeoutMs`, then `30000`).
On SELECT, the timeout is enforced server-side via MySQL's
`MAX_EXECUTION_TIME` optimizer hint. On non-SELECT statements the timeout
only closes the client socket; the server may keep the query running.

### Parameterized queries

```jsonc
// execute_query
{
  "query": "SELECT id, email FROM users WHERE org_id = ? AND active = ?",
  "params": [42, true]
}
```

Driver-side escaping prevents SQL injection. Always prefer this over
interpolating values into the `query` string.

### Large result sets

`execute_query` accepts two options that keep responses small enough for
an agent's context window:

- `format: "compact"` returns `{ columns: [...], rows: [[...]] }` instead
  of one JSON object per row, much smaller for wide tables.
- `maxResponseBytes` (default `1000000`, configurable via
  `defaults.maxResponseBytes`) caps the serialized size of returned rows.
  When exceeded, rows are truncated and the response includes
  `truncated: true`, the fetched row count, and a note.
- `offset` paginates a bare `SELECT` / `WITH…SELECT` that has no explicit
  `LIMIT`: the server appends `LIMIT n OFFSET m`. Combine with `limit` to
  page through a large result set. Ignored when the query already has a
  `LIMIT`.

### Session state

Each tool call may run on a different pooled connection. Transactions
(`BEGIN`/`COMMIT`), `SET` statements, `USE`, and temporary tables therefore
do **not** carry over between calls; don't try to span a transaction
across multiple `execute_query` invocations.

`BIGINT` values above 2^53 are returned as strings to avoid silent
precision loss, and `DATE`/`DATETIME`/`TIMESTAMP` columns are returned as
plain strings (no timezone conversion).

## Resources

For each configured connection the server exposes a resource:

- URI: `database://<connectionName>`
- MIME type: `application/json`
- Body: `{ connectionName, host, database, port, readOnly }` (no password)

## Config file reference

```json
{
  "defaults": {
    "connection": "default",
    "queryLimit": 100,
    "queryTimeoutMs": 30000,
    "maxResponseBytes": 1000000
  },
  "connections": [
    {
      "connectionName": "default",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "secret",
      "database": "myapp",
      "readOnly": false,
      "connectionLimit": 5,
      "queueLimit": 20
    },
    {
      "connectionName": "production",
      "host": "db.example.com",
      "port": 3306,
      "user": "readonly_user",
      "password": "prod-secret",
      "database": "myapp",
      "readOnly": true,
      "ssl": "Amazon RDS",
      "queryTimeoutMs": 15000
    }
  ]
}
```

| Field                          | Required | Default      | Notes                                              |
| ------------------------------ | -------- | ------------ | -------------------------------------------------- |
| `defaults.connection`           | no       | `"default"`  | Must match a configured `connectionName`.          |
| `defaults.queryLimit`           | no       | `100`        | Used when a bare `SELECT` has no top-level `LIMIT`. Hard max `10000` (enforced). |
| `defaults.queryTimeoutMs`       | no       | `30000`      | Per-query timeout in milliseconds.                 |
| `defaults.maxResponseBytes`     | no       | `1000000`    | Cap on serialized row bytes per response; rows beyond it are truncated with a notice. Min `1024`. |
| `connections[].connectionName`  | yes      | -            | Unique, `^[a-zA-Z0-9_-]+$`.                        |
| `connections[].host`            | yes      | -            |                                                    |
| `connections[].port`            | no       | `3306`       | Integer 1-65535.                                   |
| `connections[].user`            | yes      | -            |                                                    |
| `connections[].password`        | yes      | -            |                                                    |
| `connections[].database`        | yes      | -            |                                                    |
| `connections[].readOnly`        | no       | `false`      | When `true`, only read statements run. See [Read-only enforcement](#read-only-enforcement). |
| `connections[].connectionLimit` | no       | `5`          | Max connections per pool.                          |
| `connections[].queueLimit`      | no       | `20`         | Max queued requests once the pool is saturated; `0` means unbounded. |
| `connections[].queryTimeoutMs`  | no       | inherits `defaults.queryTimeoutMs` | Per-connection timeout override. Capped at 1 hour. |
| `connections[].ssl`             | no       | unset        | `true` / `false` / `"Amazon RDS"` / mysql2 SSL object (`{ ca, cert, key, rejectUnauthorized, ... }`). |
| `connections[].multipleStatements` | no    | `false`      | When `true`, allows multiple `;`-separated statements per query. Enables a class of SQL injection, so leave off unless you know you need it. |

### Config resolution order

The first source that exists wins:

1. `--config <path>` flag
2. `MCP_MYSQL_CONFIG` environment variable
3. `./mcp-mysql.config.json` (current working directory)
4. `~/.config/mcp-server-mysql/config.json`
5. `MYSQL_*` environment variables (single connection)

### Environment variables (only when no config file is found)

| Variable                | Required | Default      |
| ----------------------- | -------- | ------------ |
| `MYSQL_URL`             | no       | unset (`mysql://user:pass@host:port/db`; an alternative to the four vars below) |
| `MYSQL_HOST`            | yes (if no URL) | -     |
| `MYSQL_USER`            | yes (if no URL) | -     |
| `MYSQL_PASSWORD`        | yes (if no URL) | -     |
| `MYSQL_DATABASE`        | yes (if no URL) | -     |
| `MYSQL_PORT`            | no       | `3306`       |
| `MYSQL_CONNECTION_NAME` | no       | `default`    |
| `MYSQL_READ_ONLY`       | no       | `false` (true when value is `true` or `1`) |
| `MYSQL_SSL`             | no       | unset (`true` / `false` / `amazon-rds`) |
| `MYSQL_QUERY_TIMEOUT_MS`| no       | `30000`      |

## `mcp-server-mysql init`

```
npx -y mysql-mcp-toolkit init [--output <path>]
```

Copies the bundled `config.example.json` to the target path. Default target
is `~/.config/mcp-server-mysql/config.json`. The command refuses to
overwrite an existing file. Pick a different `--output` or delete the
target first.

## `--check`

Validate config and connectivity without starting the MCP server:

```
npx -y mysql-mcp-toolkit --check [--config <path>]
```

Loads config, pings every connection with `SELECT 1`, prints a per-
connection status report to stderr, and exits non-zero if any connection
fails. Useful before wiring the server into an MCP client.

## Security

- Never commit your config file. The included `.gitignore` excludes
  `mcp-mysql.config.json` and `config.json` at the repo root.
- Set `readOnly: true` for any connection that points at a shared or
  production database. The server enforces this at the tool layer
  before any SQL leaves the process.
- If a password leaks into git history or logs, rotate it.
- `list_databases` and `database://` resources never include passwords.
- All MCP server logging goes to **stderr**; stdout is reserved for the
  protocol.

## Development

```bash
npm install
npm run dev -- --config ./config.example.json   # expect a placeholder error
npm test
npm run build
```

## Publishing

For maintainers only:

```bash
npm run build
npm test
npm publish        # access defaults to public via publishConfig
```

The `prepublishOnly` script runs `npm run build` automatically. Bump the
version in `package.json` and add a `CHANGELOG.md` entry before publishing.

## License

MIT
