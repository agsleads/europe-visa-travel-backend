import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { env } from "@/config/env";
import { logger } from "@/lib/logger";

/**
 * One pool per process. Creating a Pool per request is the classic way to
 * exhaust `max_connections` under load.
 */
function sslConfig() {
  switch (env.DATABASE_SSL) {
    case "true":
      return true;
    // Managed providers commonly present a certificate signed by their own CA.
    // `no-verify` keeps the connection encrypted while skipping chain
    // validation; it is a deliberate, named choice, not a silent default.
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      return false;
  }
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslConfig(),
  application_name: "evc-backend",
});

/**
 * An idle client erroring (a network blip, a server-side termination) emits on
 * the pool. Without a listener Node treats it as an unhandled 'error' event
 * and kills the process.
 */
pool.on("error", (error) => {
  logger.error({ err: error }, "Unexpected error on idle PostgreSQL client");
});

/** Parameterised query. Values are always bound — never interpolated. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/**
 * Runs `fn` inside a transaction, releasing the client on every path.
 * Rollback failures are logged, not thrown — swallowing the original error
 * behind a rollback error loses the reason the transaction failed.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, "Transaction rollback failed");
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Liveness probe for the health endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    logger.error({ err: error }, "Database ping failed");
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
