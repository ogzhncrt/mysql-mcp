import { z } from "zod";

import { MAX_QUERY_LIMIT } from "./types.js";

const connectionNameRegex = /^[a-zA-Z0-9_-]+$/;

const SslOptionsSchema = z.object({
  rejectUnauthorized: z.boolean().optional(),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  minVersion: z.string().optional(),
  servername: z.string().optional(),
});

const SslPresetSchema = z.literal("Amazon RDS");

const SslConfigSchema = z.union([
  z.boolean(),
  SslPresetSchema,
  SslOptionsSchema,
]);

export const ConnectionConfigSchema = z.object({
  connectionName: z
    .string()
    .min(1, "connectionName must not be empty")
    .regex(
      connectionNameRegex,
      "connectionName may only contain letters, digits, '_' and '-'",
    ),
  host: z.string().min(1, "host must not be empty"),
  port: z
    .number()
    .int("port must be an integer")
    .min(1, "port must be >= 1")
    .max(65535, "port must be <= 65535")
    .optional(),
  user: z.string().min(1, "user must not be empty"),
  password: z.string(),
  database: z.string().min(1, "database must not be empty"),
  readOnly: z.boolean().optional(),
  connectionLimit: z
    .number()
    .int("connectionLimit must be an integer")
    .min(1, "connectionLimit must be >= 1")
    .optional(),
  queueLimit: z
    .number()
    .int("queueLimit must be an integer")
    .min(0, "queueLimit must be >= 0")
    .optional(),
  queryTimeoutMs: z
    .number()
    .int("queryTimeoutMs must be an integer")
    .min(1, "queryTimeoutMs must be >= 1")
    .optional(),
  ssl: SslConfigSchema.optional(),
  multipleStatements: z.boolean().optional(),
});

export const AppConfigSchema = z
  .object({
    defaults: z
      .object({
        connection: z.string().min(1).optional(),
        queryLimit: z
          .number()
          .int()
          .min(1)
          .max(
            MAX_QUERY_LIMIT,
            `queryLimit must be <= ${MAX_QUERY_LIMIT}`,
          )
          .optional(),
        queryTimeoutMs: z.number().int().min(1).optional(),
        maxResponseBytes: z
          .number()
          .int()
          .min(1024, "maxResponseBytes must be >= 1024")
          .optional(),
      })
      .optional(),
    connections: z
      .array(ConnectionConfigSchema)
      .min(1, "at least one connection is required"),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    for (const [i, conn] of cfg.connections.entries()) {
      if (names.has(conn.connectionName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["connections", i, "connectionName"],
          message: `duplicate connectionName "${conn.connectionName}"`,
        });
      }
      names.add(conn.connectionName);
    }

    if (cfg.defaults?.connection && !names.has(cfg.defaults.connection)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaults", "connection"],
        message: `defaults.connection "${cfg.defaults.connection}" does not match any configured connection`,
      });
    }
  });

export type ParsedAppConfig = z.infer<typeof AppConfigSchema>;
