#!/usr/bin/env node
import { parseCli, runInit } from "./cli.js";
import { ConfigError, loadConfig } from "./config/loader.js";
import { DatabaseMcpServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "init") {
    runInit(argv.slice(1));
    return;
  }

  const { configPath } = parseCli(argv);

  let config;
  try {
    const loaded = loadConfig({ cliConfigPath: configPath });
    config = loaded.config;
    process.stderr.write(
      loaded.source.kind === "file"
        ? `Loaded config from ${loaded.source.path}\n`
        : `Loaded config from environment variables\n`,
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = new DatabaseMcpServer(config);
  await server.run();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
