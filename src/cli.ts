import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { getVersion } from "./version.js";

export interface ParsedCli {
  configPath?: string;
  check?: boolean;
}

const USAGE = `mcp-server-mysql — Model Context Protocol server for MySQL

Usage:
  mcp-server-mysql [--config <path>]
  mcp-server-mysql --check [--config <path>]
  mcp-server-mysql init [--output <path>]
  mcp-server-mysql --help
  mcp-server-mysql --version

Options:
  --config <path>   Path to JSON config file. Overrides MCP_MYSQL_CONFIG and
                    auto-discovery in ./ and ~/.config/mcp-server-mysql/.
  --check           Load config, ping every connection with SELECT 1, print
                    a per-connection status report, and exit. Non-zero exit
                    if any connection fails. Useful for validating config
                    before wiring the server into an MCP client.
  --help            Print this message and exit.
  --version         Print the package version and exit.

Subcommands:
  init              Write a starter config file. Default output:
                    ~/.config/mcp-server-mysql/config.json
                    Override with --output <path>.

Environment (used only when no config file is found):
  MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE  (required)
  MYSQL_PORT              (optional, default 3306)
  MYSQL_CONNECTION_NAME   (optional, default "default")
  MYSQL_READ_ONLY         (optional, "true" or "1" enables read-only)
  MYSQL_SSL               (optional, "true" / "false" / "amazon-rds")
  MYSQL_QUERY_TIMEOUT_MS  (optional, positive integer)
`;

export function printUsage(): void {
  process.stderr.write(USAGE);
}

export function parseCli(argv: string[] = process.argv.slice(2)): ParsedCli {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${getVersion()}\n`);
    process.exit(0);
  }

  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        check: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    return { configPath: values.config, check: values.check === true };
  } catch (err) {
    process.stderr.write(
      `Error parsing arguments: ${(err as Error).message}\n\n`,
    );
    printUsage();
    process.exit(2);
  }
}

export interface InitOptions {
  output?: string;
}

export function parseInitArgs(argv: string[]): InitOptions {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        output: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    return { output: values.output };
  } catch (err) {
    process.stderr.write(
      `Error parsing arguments to "init": ${(err as Error).message}\n\n`,
    );
    printUsage();
    process.exit(2);
  }
}

export function runInit(argv: string[]): never {
  const { output } = parseInitArgs(argv);
  const target = resolve(
    output ?? defaultInitPath(),
  );

  if (existsSync(target)) {
    process.stderr.write(
      `Refusing to overwrite existing file: ${target}\n` +
        `Pick a different path with --output <path> or delete the file first.\n`,
    );
    process.exit(1);
  }

  const source = locateExampleConfig();
  if (!source) {
    process.stderr.write(
      `Could not locate bundled config.example.json. ` +
        `Reinstall mcp-server-mysql.\n`,
    );
    process.exit(1);
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  process.stderr.write(`Wrote starter config to ${target}\n`);
  process.exit(0);
}

function defaultInitPath(): string {
  return resolve(homedir(), ".config", "mcp-server-mysql", "config.json");
}

function locateExampleConfig(): string | null {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(here), "..", "config.example.json"),
    resolve(dirname(here), "..", "..", "config.example.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}
