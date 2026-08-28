import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/*
 * Environment is parsed once, at boot, through a schema. A missing or
 * malformed variable must crash the process on startup — not surface as an
 * `undefined` three layers down on the first real request.
 */

loadDotenv();

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
    /** Cap on the pg pool. Keep well under Postgres `max_connections`. */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    /** Managed providers (Neon, Supabase, RDS) terminate TLS with their own CA. */
    DATABASE_SSL: z.enum(["true", "false", "no-verify"]).default("false"),

    /**
     * Shared secret the Next.js server presents as `x-api-key`. The API is a
     * server-to-server surface: the browser never calls it directly, so a
     * static key held only on the Next server is the right weight of control.
     * Required in production — a public write endpoint with no auth is an
     * open spam funnel.
     */
    API_KEY: z.string().min(16, "API_KEY must be at least 16 characters.").optional(),

    /** Comma-separated origins allowed to call the API from a browser. */
    CORS_ORIGINS: z.string().default("").transform(csv),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    /** How long enquiry rows are retained; drives the purge routine. */
    ENQUIRY_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(365),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["API_KEY"],
        message:
          "API_KEY is required in production. Refusing to expose an unauthenticated write endpoint.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Never echo the values themselves — they are secrets.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const env = parseEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** Exported for tests, which exercise the schema without touching the real env. */
export { envSchema, parseEnv };
