export function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2,
  );
}

/**
 * Keeps items in order until their cumulative serialized size exceeds the
 * budget, then stops. Approximate by design: it measures the items only,
 * not the surrounding response envelope. Shared by every tool that returns
 * an unbounded list (query rows, schema tables) so large reads can never
 * blow past an agent's context window.
 */
export function capBySerializedSize<T>(
  items: T[],
  maxBytes: number,
): { kept: T[]; truncated: boolean } {
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    used += jsonStringify(items[i]).length + 1;
    if (used > maxBytes) {
      return { kept: items.slice(0, i), truncated: true };
    }
  }
  return { kept: items, truncated: false };
}
