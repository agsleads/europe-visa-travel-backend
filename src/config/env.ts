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
     *
     * Blank means absent. `API_KEY=` with nothing after it is how a developer
     * says "not using this yet", and treating that as a zero-length key made
     * the process refuse to boot with a length complaint about a value nobody
     * had set. Outside production the endpoint then runs unauthenticated, and
     * `apiKeyAuth` logs a warning each time so it cannot become quietly normal.
     *
     * A short key is still rejected. Four characters is not a weaker secret
     * than none — it is the same exposure plus the belief that it is covered.
     */
    API_KEY: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().min(16, "API_KEY must be at least 16 characters.").optional(),
    ),

    /**
     * Shared secret the Road Cover site sends as `x-roadcover-signature`.
     *
     * Deliberately not `API_KEY`. That key belongs to our own Next frontend;
     * this one is held by a site we do not deploy. Sharing one value would mean
     * rotating ours requires a release of theirs, and a leak of either would
     * expose both surfaces.
     *
     * Same blank-means-absent handling as API_KEY: `ROADCOVER_WEBHOOK_SECRET=`
     * with nothing after it is how a developer says "not wired up yet", and
     * outside production the endpoint then runs unauthenticated with a warning
     * on every request. A short secret is still rejected — 8 characters is not
     * weaker than none, it is the same exposure plus the belief it is covered.
     */
    ROADCOVER_WEBHOOK_SECRET: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z
        .string()
        .min(16, "ROADCOVER_WEBHOOK_SECRET must be at least 16 characters.")
        .optional(),
    ),

    /**
     * Shared secret the Final Expense Coverage site sends as
     * `x-finalexpense-signature`.
     *
     * Its own value, distinct from both `API_KEY` and the Road Cover secret, for
     * the reason each of those is distinct from the others: a leak of one must
     * not expose another surface, and rotating one must not cost a different
     * site a release. Same blank-means-absent handling and 16-character floor.
     * Outside production an unset secret leaves intake unauthenticated with a
     * warning on every request; in production `finalExpenseWebhookAuth` fails
     * closed with a 401, which is visible immediately without being an outage.
     */
    FINALEXPENSE_WEBHOOK_SECRET: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z
        .string()
        .min(16, "FINALEXPENSE_WEBHOOK_SECRET must be at least 16 characters.")
        .optional(),
    ),

    /**
     * Onyx utilization API. The key is sent as-is in the `Authorization`
     * header and never logged. Blank means absent: the endpoint then answers
     * 503 instead of calling Onyx with no credential.
     */
    ONYX_API_KEY: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().optional(),
    ),
    ONYX_API_URL: z.string().url().default("https://api.onyxplatform.com"),
    ONYX_ORGANIZATION_ID: z.coerce.number().int().positive().default(5),
    ONYX_SOURCE_ID: z.coerce.number().int().positive().default(859),
    ONYX_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),

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

    /* ROADCOVER_WEBHOOK_SECRET is deliberately NOT required here, unlike
       API_KEY, and the asymmetry is the point. API_KEY is what this service
       exists to serve; the Road Cover webhook is one integration on the side.
       Refusing to boot the enquiry API because a partner's secret has not been
       issued yet would take down the whole service for an unrelated reason.
       `roadcoverWebhookAuth` fails closed instead — in production an unset
       secret rejects every lead with a 401, which is visible immediately
       without being an outage. */
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
