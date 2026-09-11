import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { requestIdOf } from "@/api/middleware/requestId";
import { env, isProduction } from "@/config/env";
import { UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Shared-secret auth for the Road Cover webhook.
 *
 * Separate from `apiKeyAuth` even though the mechanism is identical, because
 * the credentials must be. The Road Cover site holds this secret; our own Next
 * frontend holds `API_KEY`. One shared value would mean rotating the frontend's
 * key requires a deploy of someone else's site, and a leak of either exposes
 * both surfaces.
 *
 * The header is `x-roadcover-signature`, and despite the name it is NOT an
 * HMAC -- the producer sends its `WEBHOOK_SECRET` verbatim as a bearer-style
 * value. It is compared here in constant time all the same. Both sides are
 * hashed to a fixed width first: `timingSafeEqual` throws on a length mismatch,
 * and guarding that with an early `length !==` return leaks the secret's length
 * through timing.
 *
 * TODO(producer): a real HMAC over the request body would also prove the body
 * was not altered in transit, which a static shared secret cannot. That needs a
 * change at the producer, so it is noted rather than done.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function roadcoverWebhookAuth(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.ROADCOVER_WEBHOOK_SECRET;

  if (!expected) {
    /* Env validation makes the secret mandatory in production, so this branch
       is development and test only. Loud on purpose: an unauthenticated
       endpoint that accepts personal data and consent records should never
       become quietly normal. */
    if (isProduction) {
      return next(new UnauthorizedError("The Road Cover webhook secret is not configured."));
    }
    logger.warn(
      { path: req.path },
      "ROADCOVER_WEBHOOK_SECRET unset — lead intake is unauthenticated (non-production)",
    );
    return next();
  }

  const provided = req.get("x-roadcover-signature") ?? "";
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    // No secret material, provided or expected, ever reaches the log.
    logger.warn(
      { requestId: requestIdOf(req), path: req.path },
      "Rejected Road Cover webhook with an invalid signature",
    );
    return next(new UnauthorizedError("Missing or invalid webhook signature."));
  }

  next();
}
