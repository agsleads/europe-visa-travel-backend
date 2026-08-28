import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { requestIdOf } from "@/api/middleware/requestId";
import { env, isProduction } from "@/config/env";
import { UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Shared-secret auth for the server-to-server surface.
 *
 * Keys are compared in constant time. They are hashed to a fixed width first:
 * `timingSafeEqual` throws on length mismatch, and guarding that with an early
 * `length !==` return leaks the key length through timing — hashing removes
 * both problems at once.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.API_KEY;

  if (!expected) {
    /* Env validation already makes API_KEY mandatory in production, so this
       branch is development and test only. It is loud on purpose — an
       unauthenticated write endpoint should never be quietly normal. */
    if (isProduction) return next(new UnauthorizedError("API key is not configured."));
    logger.warn({ path: req.path }, "API_KEY unset — endpoint is unauthenticated (non-production)");
    return next();
  }

  const provided = req.get("x-api-key") ?? "";
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    // No key material, provided or expected, ever reaches the log.
    logger.warn({ requestId: requestIdOf(req), path: req.path }, "Rejected request with invalid API key");
    return next(new UnauthorizedError());
  }

  next();
}
