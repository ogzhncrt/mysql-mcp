import type { AppConfig } from "./config/types.js";
import { PoolManager } from "./db/pool-manager.js";

/**
 * Ping every configured connection with `SELECT 1` and print a per-
 * connection status report to stderr. Returns true if all connections
 * succeeded, false if any failed.
 */
export async function runCheck(config: AppConfig): Promise<boolean> {
  const pools = new PoolManager(config.connections);
  const names = pools.listConnectionNames();
  let allOk = true;

  process.stderr.write(`Checking ${names.length} connection(s)...\n`);

  for (const name of names) {
    const conn = pools.getConfig(name);
    const label = `  ${name} (${conn.host}/${conn.database})`;
    const started = Date.now();
    try {
      await pools.ping(name);
      const ms = Date.now() - started;
      process.stderr.write(`${label}: OK (${ms}ms)\n`);
    } catch (err) {
      const ms = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${label}: FAIL (${ms}ms) — ${msg}\n`);
      allOk = false;
    }
  }

  await pools.closeAll();
  return allOk;
}
