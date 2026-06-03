# mcp-server-mysql

[![npm](https://img.shields.io/npm/v/mysql-mcp-toolkit.svg)](https://www.npmjs.com/package/mysql-mcp-toolkit)

A Model Context Protocol (MCP) server for MySQL. Lets Cursor and other MCP
clients list tables, describe schema, and run SQL against any MySQL database
you configure — over stdio, with read-only protection for production
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
           "mysql-mcp-toolkit",
           "--config",
           "/absolute/path/to/config.json"
         ]
       }
     }
   }
   ```

4. Restart Cursor. You should see `mysql` show up under MCP tools.

## Quick start (env vars only)

If you only need one connection, skip the config file entirely:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "mysql-mcp-toolkit"],
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

## Tools

| Tool                | What it does                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_query`     | Run any SQL. Supports `params` for `?` placeholders. Bare `SELECT`s get an auto `LIMIT` (max 10,000) and a `MAX_EXECUTION_TIME` optimizer hint so `timeoutMs` cancels the query **server-side** on MySQL 5.7.4+. Read-only connections reject INSERT/UPDATE/DELETE/DDL/`CALL`, including CTE-disguised writes. |
| `explain_query`     | `EXPLAIN` a statement without executing it. Supports `format: TRADITIONAL\|JSON\|TREE` and `params`. Safe on read-only connections.                                                                                                                                                                           |
| `list_tables`       | `SHOW TABLES` on the chosen connection.                                                                                                                                                                                                                                                                       |
| `describe_table`    | `DESCRIBE <table>` + `SHOW INDEXES FROM <table>`. Identifier must be 1–64 chars and contain no backticks or control characters (dollar signs, hyphens, and unicode letters are fine).                                                                                                                         |
| `show_create_table` | Returns the full `CREATE TABLE` statement — column types, defaults, indexes, foreign keys, engine, charset. Also works on views (returns `CREATE VIEW`).                                                                                                                                                      |
| `list_databases`    | Lists configured connections (host, database, port, read-only flag, ssl flag). Never includes passwords.                                                                                                                                                                                                      |

Each tool accepts an optional `connection` argument. If omitted, the default
from `defaults.connection` (or the literal `"default"`) is used. Tools that
run user-supplied SQL also accept an optional `timeoutMs` (defaults to the
connection's `queryTimeoutMs`, then `defaults.queryTimeoutMs`, then `30000`).
On SELECT, the timeout is enforced server-side via MySQL's
`MAX_EXECUTION_TIME` optimizer hint. On non-SELECT statements the timeout
only closes the client socket — the server may keep the query running.

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
    "queryTimeoutMs": 30000
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
      "connectionLimit": 5
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
| `defaults.queryLimit`           | no       | `100`        | Used when a bare `SELECT` has no `LIMIT`. Hard max `10000`. |
| `defaults.queryTimeoutMs`       | no       | `30000`      | Per-query timeout in milliseconds.                 |
| `connections[].connectionName`  | yes      | —            | Unique, `^[a-zA-Z0-9_-]+$`.                        |
| `connections[].host`            | yes      | —            |                                                    |
| `connections[].port`            | no       | `3306`       | Integer 1–65535.                                   |
| `connections[].user`            | yes      | —            |                                                    |
| `connections[].password`        | yes      | —            |                                                    |
| `connections[].database`        | yes      | —            |                                                    |
| `connections[].readOnly`        | no       | `false`      | When `true`, write statements (incl. CTE writes and `CALL`) throw. |
| `connections[].connectionLimit` | no       | `5`          | Max connections per pool.                          |
| `connections[].queryTimeoutMs`  | no       | inherits `defaults.queryTimeoutMs` | Per-connection timeout override. |
| `connections[].ssl`             | no       | unset        | `true` / `false` / `"Amazon RDS"` / mysql2 SSL object (`{ ca, cert, key, rejectUnauthorized, ... }`). |
| `connections[].multipleStatements` | no    | `false`      | When `true`, allows multiple `;`-separated statements per query. Enables a class of SQL injection — leave off unless you know you need it. |

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
| `MYSQL_HOST`            | yes      | —            |
| `MYSQL_USER`            | yes      | —            |
| `MYSQL_PASSWORD`        | yes      | —            |
| `MYSQL_DATABASE`        | yes      | —            |
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
overwrite an existing file — pick a different `--output` or delete the
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
