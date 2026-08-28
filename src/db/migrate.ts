import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { closePool, pool } from "@/db/pool";
import { logger } from "@/lib/logger";

/**
 * A small forward-only migration runner.
 *
 * Deliberately not a framework. The requirements are: run each .sql file once,
 * in filename order, inside a transaction, and refuse to run if a file that
 * has already been applied was edited afterwards. That last check is the one
 * most hand-rolled runners omit, and it is the one that catches the genuinely
 * dangerous mistake — an already-applied migration silently rewritten, so
 * production and a fresh database no longer have the same schema.
 */

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT        PRIMARY KEY,
    checksum    TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/** Advisory lock id — arbitrary but fixed, so concurrent deploys serialise. */
const LOCK_ID = 8_472_019;

type MigrationFile = { name: string; sql: string; checksum: string };

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort() // 001_, 002_, … — zero-padded prefixes make lexical order correct.
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

export async function migrate(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    // Blocks until any other deploying instance finishes; released with the
    // session, so a crashed migrator cannot deadlock the next one forever.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(CREATE_MIGRATIONS_TABLE);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const migration of loadMigrations(dir)) {
      const previous = seen.get(migration.name);

      if (previous) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration "${migration.name}" was modified after it was applied. ` +
              "Applied migrations are immutable — add a new migration instead.",
          );
        }
        continue;
      }

      // Each migration is its own transaction: a failure leaves the earlier
      // ones applied and recorded, so a re-run resumes rather than restarts.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration "${migration.name}" failed: ${(error as Error).message}`, {
          cause: error,
        });
      }

      applied.push(migration.name);
      logger.info({ migration: migration.name }, "Applied migration");
    }

    if (applied.length === 0) logger.info("No pending migrations");
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/* Run directly (`npm run migrate`) rather than when imported by a test. */
if (require.main === module) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, "Migration failed");
      void closePool().finally(() => process.exit(1));
    });
}
