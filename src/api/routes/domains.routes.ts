import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { domainRepository, type DomainRepository } from "@/repositories/domain.repository";

/**
 * /api/v1/domains — the lead businesses CRM admins and users belong to
 * (Europe Visa Centre, Road Cover, ...). Read-only; the list is seeded by
 * migration 018.
 */
export function domainsRouter(repository: DomainRepository = domainRepository): Router {
  const router = Router();

  router.get(
    "/",
    apiKeyAuth,
    asyncHandler(async (_req, res) => {
      res.json({ data: await repository.list() });
    }),
  );

  return router;
}
