import { describe, expect, it } from "vitest";

import type { ConnectionConfig } from "../src/config/types.js";
import {
  ReadOnlyViolationError,
  assertCanExecute,
  isSelectQuery,
  isWriteQuery,
  stripCommentsAndStrings,
} from "../src/db/query-guard.js";

const writeable: ConnectionConfig = {
  connectionName: "default",
  host: "127.0.0.1",
  user: "root",
  password: "secret",
  database: "myapp",
  readOnly: false,
};

const readonly: ConnectionConfig = {
  ...writeable,
  connectionName: "prod",
  readOnly: true,
};

describe("isWriteQuery", () => {
  it("returns false for SELECT", () => {
    expect(isWriteQuery("SELECT * FROM users")).toBe(false);
    expect(isWriteQuery("  select 1")).toBe(false);
  });

  it("returns true for write prefixes", () => {
    for (const sql of [
      "INSERT INTO users VALUES (1)",
      "update users set name='x'",
      "DELETE FROM users",
      "DROP TABLE users",
      "TRUNCATE users",
      "  alter table users add column foo int",
      "REPLACE INTO users VALUES (1)",
    ]) {
      expect(isWriteQuery(sql)).toBe(true);
    }
  });

  it("does not match prefixes that are part of identifiers", () => {
    expect(isWriteQuery("SELECTFOO * FROM x")).toBe(false);
    expect(isWriteQuery("INSERTED ...")).toBe(false);
  });

  it("catches CTE-disguised writes (regression: pre-1.1 bypass)", () => {
    expect(
      isWriteQuery("WITH foo AS (SELECT 1) DELETE FROM users WHERE id IN foo"),
    ).toBe(true);
    expect(
      isWriteQuery(
        "WITH x AS (SELECT 1)\nINSERT INTO logs (id) SELECT id FROM x",
      ),
    ).toBe(true);
    expect(
      isWriteQuery(
        "WITH RECURSIVE t AS (SELECT 1) UPDATE users SET name='x'",
      ),
    ).toBe(true);
  });

  it("catches CALL of stored procedures", () => {
    expect(isWriteQuery("CALL sp_delete_everything()")).toBe(true);
    expect(isWriteQuery("  call my_proc(1, 2)")).toBe(true);
  });

  it("ignores write keywords inside string literals", () => {
    expect(isWriteQuery("SELECT 'DELETE FROM users' AS note")).toBe(false);
    expect(isWriteQuery(`SELECT "INSERT INTO x" AS s`)).toBe(false);
    expect(isWriteQuery("SELECT 'it''s safe DELETE' FROM dual")).toBe(false);
  });

  it("ignores write keywords inside comments", () => {
    expect(isWriteQuery("SELECT 1 -- DELETE FROM users")).toBe(false);
    expect(isWriteQuery("SELECT 1 /* DROP TABLE x */ FROM dual")).toBe(false);
    expect(isWriteQuery("SELECT 1\n# UPDATE x SET y=1")).toBe(false);
  });
});

describe("stripCommentsAndStrings", () => {
  it("strips block, line, and # comments", () => {
    expect(
      stripCommentsAndStrings("SELECT 1 /* DROP */ -- DELETE\nFROM t # CALL")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("SELECT 1 FROM t");
  });

  it("strips single- and double-quoted strings", () => {
    expect(stripCommentsAndStrings("'DELETE'")).not.toMatch(/DELETE/);
    expect(stripCommentsAndStrings('"DROP TABLE"')).not.toMatch(/DROP/);
  });
});

describe("isSelectQuery", () => {
  it("identifies SELECT statements", () => {
    expect(isSelectQuery("SELECT 1")).toBe(true);
    expect(isSelectQuery("  select * from t")).toBe(true);
    expect(isSelectQuery("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

describe("assertCanExecute", () => {
  it("allows SELECT on a read-only connection", () => {
    expect(() => assertCanExecute(readonly, "SELECT 1")).not.toThrow();
  });

  it("allows writes on a writeable connection", () => {
    expect(() =>
      assertCanExecute(writeable, "INSERT INTO users VALUES (1)"),
    ).not.toThrow();
  });

  it("throws the expected message on read-only + INSERT", () => {
    expect(() =>
      assertCanExecute(readonly, "INSERT INTO users VALUES (1)"),
    ).toThrowError(ReadOnlyViolationError);

    expect(() =>
      assertCanExecute(readonly, "INSERT INTO users VALUES (1)"),
    ).toThrowError(
      'Connection "prod" is read-only. Only SELECT and other read operations are allowed.',
    );
  });
});
