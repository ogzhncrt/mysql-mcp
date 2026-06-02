import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config/loader.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function writeTempConfig(contents: unknown): {
  dir: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mysql-loader-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return { dir, path };
}

describe("loadConfig", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads multiple connections from a valid config file", () => {
    const { dir, path } = writeTempConfig({
      defaults: { connection: "default", queryLimit: 50 },
      connections: [
        {
          connectionName: "default",
          host: "127.0.0.1",
          port: 3306,
          user: "root",
          password: "real-password",
          database: "myapp",
        },
        {
          connectionName: "prod",
          host: "db.example.com",
          port: 3306,
          user: "readonly",
          password: "another-real-secret",
          database: "myapp",
          readOnly: true,
        },
      ],
    });
    created.push(dir);

    const { config, source } = loadConfig({
      cliConfigPath: path,
      env: EMPTY_ENV,
    });

    expect(source).toEqual({ kind: "file", path });
    expect(config.connections).toHaveLength(2);
    expect(config.connections[1].readOnly).toBe(true);
    expect(config.defaults?.queryLimit).toBe(50);
  });

  it('throws when all connections contain the "your-" placeholder', () => {
    const { dir, path } = writeTempConfig({
      connections: [
        {
          connectionName: "default",
          host: "127.0.0.1",
          user: "root",
          password: "your-password",
          database: "myapp",
        },
      ],
    });
    created.push(dir);

    expect(() =>
      loadConfig({ cliConfigPath: path, env: EMPTY_ENV }),
    ).toThrowError(ConfigError);
  });

  it("builds a single connection from MYSQL_* env vars", () => {
    const env: NodeJS.ProcessEnv = {
      MYSQL_HOST: "127.0.0.1",
      MYSQL_USER: "root",
      MYSQL_PASSWORD: "secret",
      MYSQL_DATABASE: "myapp",
      MYSQL_PORT: "3307",
      MYSQL_READ_ONLY: "true",
    };

    const { config, source } = loadConfig({ env, cwd: "/nonexistent-cwd" });

    expect(source).toEqual({ kind: "env" });
    expect(config.connections).toHaveLength(1);
    expect(config.connections[0]).toMatchObject({
      connectionName: "default",
      host: "127.0.0.1",
      port: 3307,
      readOnly: true,
    });
  });

  it("throws ConfigError when no source is available", () => {
    expect(() =>
      loadConfig({ env: EMPTY_ENV, cwd: "/nonexistent-cwd" }),
    ).toThrowError(ConfigError);
  });

  it("rejects duplicate connectionName", () => {
    const { dir, path } = writeTempConfig({
      connections: [
        {
          connectionName: "dup",
          host: "127.0.0.1",
          user: "root",
          password: "real-pw-1",
          database: "a",
        },
        {
          connectionName: "dup",
          host: "127.0.0.1",
          user: "root",
          password: "real-pw-2",
          database: "b",
        },
      ],
    });
    created.push(dir);

    expect(() =>
      loadConfig({ cliConfigPath: path, env: EMPTY_ENV }),
    ).toThrowError(/duplicate connectionName/);
  });

  it("accepts ssl as boolean, preset, or object", () => {
    const { dir, path } = writeTempConfig({
      defaults: { connection: "rds", queryTimeoutMs: 60000 },
      connections: [
        {
          connectionName: "rds",
          host: "db.example.com",
          user: "app",
          password: "real-secret-rds",
          database: "myapp",
          ssl: "Amazon RDS",
          queryTimeoutMs: 45000,
        },
        {
          connectionName: "tls",
          host: "db2.example.com",
          user: "app",
          password: "real-secret-tls",
          database: "myapp",
          ssl: { rejectUnauthorized: false },
        },
        {
          connectionName: "plain",
          host: "127.0.0.1",
          user: "app",
          password: "real-secret-plain",
          database: "myapp",
          ssl: true,
        },
      ],
    });
    created.push(dir);

    const { config } = loadConfig({ cliConfigPath: path, env: EMPTY_ENV });
    expect(config.connections[0].ssl).toBe("Amazon RDS");
    expect(config.connections[1].ssl).toEqual({ rejectUnauthorized: false });
    expect(config.connections[2].ssl).toBe(true);
    expect(config.connections[0].queryTimeoutMs).toBe(45000);
    expect(config.defaults?.queryTimeoutMs).toBe(60000);
  });

  it("parses MYSQL_SSL and MYSQL_QUERY_TIMEOUT_MS env vars", () => {
    const { config } = loadConfig({
      env: {
        MYSQL_HOST: "127.0.0.1",
        MYSQL_USER: "root",
        MYSQL_PASSWORD: "secret",
        MYSQL_DATABASE: "myapp",
        MYSQL_SSL: "amazon-rds",
        MYSQL_QUERY_TIMEOUT_MS: "5000",
      },
      cwd: "/nonexistent-cwd",
    });
    expect(config.connections[0].ssl).toBe("Amazon RDS");
    expect(config.connections[0].queryTimeoutMs).toBe(5000);
  });

  it("rejects invalid port", () => {
    const { dir, path } = writeTempConfig({
      connections: [
        {
          connectionName: "default",
          host: "127.0.0.1",
          port: 99999,
          user: "root",
          password: "real-secret",
          database: "myapp",
        },
      ],
    });
    created.push(dir);

    expect(() =>
      loadConfig({ cliConfigPath: path, env: EMPTY_ENV }),
    ).toThrowError(/port/);
  });
});
