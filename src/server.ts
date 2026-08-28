import type { Server } from "node:http";

import { createApp } from "@/api/app";
import { env } from "@/config/env";
import { closePool, pingDatabase } from "@/db/pool";
import { logger } from "@/lib/logger";

/**
 * Process entry point: connect, listen, and shut down cleanly.
 */
async function start(): Promise<void> {
  /* Fail fast. A process that binds a port while its database is unreachable
     passes the platform's health check and then 500s every real request. */
  if (!(await pingDatabase())) {
    throw new Error("Cannot reach PostgreSQL. Check DATABASE_URL and that the server is running.");
  }

  const server: Server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "EVC API listening");
  });

  /**
   * Graceful shutdown. `server.close` stops accepting new connections and
   * waits for in-flight requests, so a deploy does not drop an enquiry
   * mid-INSERT. The timer is the backstop for a hung connection; `unref` keeps
   * that timer itself from holding the process open.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // A second Ctrl-C must not race the first.
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");

    const force = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(() => {
      void closePool()
        .catch((error: unknown) => logger.error({ err: error }, "Error closing pool"))
        .finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /* An unhandled rejection leaves the process in an unknown state. Log it and
     let the platform restart a clean one rather than serve from a corrupt one. */
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    shutdown("unhandledRejection");
  });
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start server");
  process.exit(1);
});
