import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getVersion(): string {
  if (cached) return cached;
  try {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
      resolve(dirname(here), "..", "package.json"),
      resolve(dirname(here), "..", "..", "package.json"),
    ];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
          version?: string;
        };
        if (typeof pkg.version === "string") {
          cached = pkg.version;
          return cached;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fall through
  }
  cached = "0.0.0-unknown";
  return cached;
}
