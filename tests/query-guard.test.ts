import { describe, expect, it } from "vitest";

import type { ConnectionConfig } from "../src/config/types.js";
import {
  ReadOnlyViolationError,
  assertCanExecute,
  containsTopLevelLimit,
  findOuterSelectEnd,
  isMultiStatement,
  isSelectQuery,
  isWriteQuery,
  stripCommentsAndStrings,
  trimTrailingNoise,
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
  it("returns false for read statements", () => {
    for (const sql of [
      "SELECT * FROM users",
      "  select 1",
      "SHOW TABLES",
      "SHOW CREATE TABLE users", // regression: CREATE keyword inside SHOW
      "DESCRIBE users",
      "EXPLAIN UPDATE t SET a=1", // EXPLAIN does not execute
      "EXPLAIN FORMAT=TREE SELECT 1",
      "CHECKSUM TABLE users",
      "TABLE users",
      "(SELECT 1) UNION (SELECT 2)",
      "WITH x AS (SELECT 1) SELECT * FROM x",
    ]) {
      expect(isWriteQuery(sql), sql).toBe(false);
    }
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
      expect(isWriteQuery(sql), sql).toBe(true);
    }
  });

  it("default-denies starters that are not known reads (1.3 hardening)", () => {
    for (const sql of [
      "LOAD DATA INFILE '/tmp/x' INTO TABLE t",
      "SET GLOBAL max_connections = 1",
      "SET SESSION sql_mode = ''",
      "KILL 1234",
      "FLUSH PRIVILEGES",
      "RESET MASTER",
      "PURGE BINARY LOGS TO 'x'",
      "OPTIMIZE TABLE t",
      "REPAIR TABLE t",
      "ANALYZE TABLE t",
      "DO SLEEP(9999)",
      "HANDLER t OPEN",
      "BEGIN",
      "START TRANSACTION",
      "COMMIT",
      "USE otherdb",
      "PREPARE s FROM 'SELECT 1'",
      "LOCK TABLES t WRITE",
      "GRANT ALL ON *.* TO 'x'",
      "CALL sp_delete_everything()",
      "SELECTFOO * FROM x", // garbage starter -> deny
    ]) {
      expect(isWriteQuery(sql), sql).toBe(true);
    }
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

  it("catches EXPLAIN ANALYZE, which executes the statement", () => {
    expect(isWriteQuery("EXPLAIN ANALYZE SELECT * FROM t")).toBe(true);
    expect(isWriteQuery("DESC ANALYZE SELECT * FROM t")).toBe(true);
    expect(isWriteQuery("/* c */ EXPLAIN /* c */ ANALYZE SELECT 1")).toBe(
      true,
    );
  });

  it("catches SELECT ... INTO OUTFILE / DUMPFILE", () => {
    expect(isWriteQuery("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toBe(true);
    expect(isWriteQuery("SELECT x FROM t INTO DUMPFILE '/tmp/x'")).toBe(true);
  });

  it("catches SELECT ... FOR UPDATE (acquires write locks)", () => {
    expect(isWriteQuery("SELECT * FROM t WHERE id = 1 FOR UPDATE")).toBe(true);
  });

  it("checks every statement in a multi-statement string", () => {
    expect(isWriteQuery("SELECT 1; DELETE FROM t")).toBe(true);
    expect(isWriteQuery("SELECT 1; FLUSH PRIVILEGES")).toBe(true);
    expect(isWriteQuery("SELECT 1; SELECT 2;")).toBe(false);
  });

  it("does not flag backtick-quoted identifiers (regression: 1.2 false positive)", () => {
    expect(isWriteQuery("SELECT `update` FROM audit")).toBe(false);
    expect(isWriteQuery("SELECT `delete`, `create` FROM `drop`")).toBe(false);
  });

  it("does not flag SQL functions that share write-keyword names", () => {
    expect(isWriteQuery("SELECT REPLACE(name, 'a', 'b') FROM t")).toBe(false);
    expect(isWriteQuery("SELECT INSERT('abcd', 2, 2, 'xy')")).toBe(false);
    expect(isWriteQuery("SELECT TRUNCATE(2.567, 1)")).toBe(false);
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

  it("masks single- and double-quoted strings", () => {
    expect(stripCommentsAndStrings("'DELETE'")).not.toMatch(/DELETE/);
    expect(stripCommentsAndStrings('"DROP TABLE"')).not.toMatch(/DROP/);
  });

  it("masks backtick-quoted identifiers", () => {
    expect(stripCommentsAndStrings("SELECT `update` FROM t")).not.toMatch(
      /update/i,
    );
  });

  it("preserves string length (positions map 1:1)", () => {
    const sql = "SELECT 'a;b' /* c */ FROM `t` -- x";
    expect(stripCommentsAndStrings(sql)).toHaveLength(sql.length);
  });

  it("does not treat comment markers inside strings as comments", () => {
    const masked = stripCommentsAndStrings("SELECT '-- not a comment', 1");
    expect(masked).toMatch(/, 1\s*$/);
  });
});

describe("isSelectQuery", () => {
  it("identifies SELECT statements", () => {
    expect(isSelectQuery("SELECT 1")).toBe(true);
    expect(isSelectQuery("  select * from t")).toBe(true);
    expect(isSelectQuery("/* hint */ SELECT 1")).toBe(true);
    expect(isSelectQuery("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

describe("findOuterSelectEnd", () => {
  it("points just past a leading SELECT", () => {
    expect(findOuterSelectEnd("SELECT 1")).toBe(6);
    expect(findOuterSelectEnd("  /* c */ select 1")).toBe(16);
  });

  it("points past the main SELECT of a CTE", () => {
    const sql = "WITH x AS (SELECT 1) SELECT * FROM x";
    expect(findOuterSelectEnd(sql)).toBe(sql.indexOf("SELECT * FROM x") + 6);
  });

  it("handles RECURSIVE, multi-CTE, and column lists", () => {
    const sql =
      "WITH RECURSIVE a AS (SELECT 1 UNION SELECT 2), b (n) AS (SELECT 3) SELECT * FROM a, b";
    expect(findOuterSelectEnd(sql)).toBe(sql.lastIndexOf("SELECT") + 6);
  });

  it("returns null for writes, CTE writes, and non-SELECT reads", () => {
    expect(findOuterSelectEnd("INSERT INTO t VALUES (1)")).toBeNull();
    expect(
      findOuterSelectEnd("WITH x AS (SELECT 1) INSERT INTO logs SELECT id FROM x"),
    ).toBeNull();
    expect(findOuterSelectEnd("SHOW TABLES")).toBeNull();
    expect(findOuterSelectEnd("TABLE users")).toBeNull();
    expect(findOuterSelectEnd("SELECTFOO * FROM x")).toBeNull();
  });
});

describe("isMultiStatement", () => {
  it("is false for a single statement (with trailing noise)", () => {
    expect(isMultiStatement("SELECT 1")).toBe(false);
    expect(isMultiStatement("SELECT 1;")).toBe(false);
    expect(isMultiStatement("SELECT 1; -- done")).toBe(false);
    expect(isMultiStatement("SELECT ';' AS s")).toBe(false);
  });

  it("is true when more than one statement is present", () => {
    expect(isMultiStatement("SELECT 1; SELECT 2")).toBe(true);
    expect(isMultiStatement("SELECT 1; DELETE FROM t")).toBe(true);
  });
});

describe("containsTopLevelLimit", () => {
  it("detects a top-level LIMIT", () => {
    expect(containsTopLevelLimit("SELECT * FROM t LIMIT 5")).toBe(true);
    expect(containsTopLevelLimit("SELECT * FROM t limit 5 OFFSET 2")).toBe(
      true,
    );
  });

  it("ignores LIMIT inside strings and comments", () => {
    expect(
      containsTopLevelLimit("SELECT * FROM t WHERE n = 'add LIMIT here'"),
    ).toBe(false);
    expect(containsTopLevelLimit("SELECT * FROM t -- LIMIT 10")).toBe(false);
  });

  it("ignores LIMIT inside subqueries (regression: 1.2 missed outer cap)", () => {
    expect(
      containsTopLevelLimit("SELECT * FROM (SELECT 1 LIMIT 5) x"),
    ).toBe(false);
    expect(
      containsTopLevelLimit("SELECT * FROM (SELECT 1 LIMIT 5) x LIMIT 3"),
    ).toBe(true);
  });

  it("does not match identifiers containing LIMIT", () => {
    expect(containsTopLevelLimit("SELECT rate_limit FROM t")).toBe(false);
    expect(containsTopLevelLimit("SELECT limit$x FROM t")).toBe(false);
  });
});

describe("trimTrailingNoise", () => {
  it("removes trailing semicolons and whitespace", () => {
    expect(trimTrailingNoise("SELECT 1;  ")).toBe("SELECT 1");
    expect(trimTrailingNoise("SELECT 1;;")).toBe("SELECT 1");
  });

  it("removes trailing comments, including after a semicolon", () => {
    expect(trimTrailingNoise("SELECT 1 -- done")).toBe("SELECT 1");
    expect(trimTrailingNoise("SELECT 1; -- done")).toBe("SELECT 1");
    expect(trimTrailingNoise("SELECT 1 /* c */")).toBe("SELECT 1");
  });

  it("never cuts into a trailing string literal", () => {
    expect(trimTrailingNoise("SELECT ';'")).toBe("SELECT ';'");
    expect(trimTrailingNoise("SELECT '-- x'")).toBe("SELECT '-- x'");
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
