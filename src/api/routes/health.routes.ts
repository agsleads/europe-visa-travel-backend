import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { pingDatabase } from "@/db/pool";

/**
 * Two probes, because they answer different questions and a platform that
 * conflates them restarts healthy containers.
 *
 * /health/live — is the process up? Never touches the database. If this were
 *   wired to Postgres, a brief database blip would make the orchestrator kill
 *   and reschedule every instance, turning a recoverable outage into a total one.
 * /health — is the process able to serve traffic? Checks the database, and
 *   returns 503 when it cannot, so the load balancer drains this instance.
 */
export function healthRouter(): Router {
  const router = Router();

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const database = await pingDatabase();
      res.status(database ? 200 : 503).json({
        status: database ? "ok" : "degraded",
        checks: { database: database ? "up" : "down" },
        uptime: process.uptime(),
      });
    }),
  );

  return router;
}
