import { describe, expect, it } from "vitest";

import {
  assertValidIdentifier,
  escapeIdentifier,
  isValidIdentifier,
} from "../src/lib/identifiers.js";

describe("isValidIdentifier", () => {
  it("accepts common identifiers", () => {
    for (const name of [
      "users",
      "user_orders",
      "users_v2",
      "users$archive",
      "my-table",
      "Π_table_unicode",
    ]) {
      expect(isValidIdentifier(name)).toBe(true);
    }
  });

  it("rejects backticks, control chars, empty, and over-length", () => {
    expect(isValidIdentifier("")).toBe(false);
    expect(isValidIdentifier("a`b")).toBe(false);
    expect(isValidIdentifier("a\0b")).toBe(false);
    expect(isValidIdentifier("a\nb")).toBe(false);
    expect(isValidIdentifier("a".repeat(65))).toBe(false);
  });
});

describe("assertValidIdentifier", () => {
  it("throws with field name in message", () => {
    expect(() => assertValidIdentifier("bad`name", "table")).toThrow(
      /"table".*bad`name/,
    );
  });
});

describe("escapeIdentifier", () => {
  it("wraps in backticks and doubles internal backticks", () => {
    expect(escapeIdentifier("users")).toBe("`users`");
    expect(escapeIdentifier("we`ird")).toBe("`we``ird`");
  });
});
