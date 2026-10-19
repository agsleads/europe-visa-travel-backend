import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { requestIdOf } from "@/api/middleware/requestId";
import { env, isProduction } from "@/config/env";
import { UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Shared-secret auth for lead producers that are separate sites.
 *
 * Separate from `apiKeyAuth` even though the mechanism is identical, because
 * the credentials must be. A producer site holds its own secret; our own Next
 * frontend holds `API_KEY`. One shared value would mean rotating the frontend's
 * key requires a deploy of someone else's site, and a leak of either exposes
 * both surfaces. Each producer also gets its *own* secret, for the same reason
 * between them: rotating one partner must not cost another a release.
 *
 * The secret is compared in constant time. Both sides are hashed to a fixed
 * width first: `timingSafeEqual` throws on a length mismatch, and guarding that
 * with an early `length !==` return leaks the secret's length through timing.
 *
 * Fails closed in production. An unset secret rejects every request with a 401
 * rather than admitting them, so a missed deploy variable is visible at once
 * without being an outage for the rest of the service.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

interface SharedSecretAuthOptions {
  /** The request header the producer sends its secret in. */
  header: string;
  /**
   * Read on every request, not captured at import, so the value is whatever the
   * parsed environment holds at the moment of the call.
   */
  secret: () => string | undefined;
  /** The environment variable name, for the warning when it is unset. */
  envName: string;
  /** Human name of the producer, e.g. "Road Cover webhook". Used in logs and errors. */
  label: string;
  /**
   * What a caller is told when the credential is wrong. Defaults to the
   * webhook wording; an integration that calls its credential an API key
   * overrides it, so the message names the thing the caller was given.
   */
  invalidMessage?: string;
}

function createSharedSecretAuth({
  header,
  secret,
  envName,
  label,
  invalidMessage = "Missing or invalid webhook signature.",
}: SharedSecretAuthOptions) {
  return function sharedSecretAuth(req: Request, _res: Response, next: NextFunction): void {
    const expected = secret();

    if (!expected) {
      /* Outside production an unset secret lets the request through, which is
         what makes local development possible without issuing a credential.
         Loud on purpose: an unauthenticated endpoint that accepts personal data
         and consent records should never become quietly normal. */
      if (isProduction) {
        return next(new UnauthorizedError(`The ${label} secret is not configured.`));
      }
      logger.warn(
        { path: req.path },
        `${envName} unset — lead intake is unauthenticated (non-production)`,
      );
      return next();
    }

    const provided = req.get(header) ?? "";
    if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
      // No secret material, provided or expected, ever reaches the log.
      logger.warn(
        { requestId: requestIdOf(req), path: req.path },
        `Rejected ${label} with an invalid signature`,
      );
      return next(new UnauthorizedError(invalidMessage));
    }

    next();
  };
}

/**
 * Auth for the Road Cover webhook (`x-roadcover-signature`).
 *
 * Despite the header's name it is NOT an HMAC -- the producer sends its
 * `WEBHOOK_SECRET` verbatim as a bearer-style value.
 *
 * TODO(producer): a real HMAC over the request body would also prove the body
 * was not altered in transit, which a static shared secret cannot. That needs a
 * change at the producer, so it is noted rather than done.
 */
export const roadcoverWebhookAuth = createSharedSecretAuth({
  header: "x-roadcover-signature",
  secret: () => env.ROADCOVER_WEBHOOK_SECRET,
  envName: "ROADCOVER_WEBHOOK_SECRET",
  label: "Road Cover webhook",
});

/**
 * Auth for Final Expense Coverage lead intake (`x-finalexpense-signature`).
 *
 * The site's Next.js server route sends its secret verbatim, and only from the
 * server -- the browser never sees it, so it is not a public key on a write
 * endpoint. Same limit as the Road Cover one: a static secret proves who is
 * calling, not that the body was not altered on the way.
 */
export const finalExpenseWebhookAuth = createSharedSecretAuth({
  header: "x-finalexpense-signature",
  secret: () => env.FINALEXPENSE_WEBHOOK_SECRET,
  envName: "FINALEXPENSE_WEBHOOK_SECRET",
  label: "Final Expense webhook",
});

/**
 * Auth for Senior Health Benefits Medicare lead intake
 * (`x-seniorhealth-signature`).
 *
 * The site's Next.js server route sends its secret verbatim, and only from the
 * server -- the browser never sees it, so it is not a public key on a write
 * endpoint. Same limit as the others: a static secret proves who is calling,
 * not that the body was not altered on the way.
 */
export const seniorHealthWebhookAuth = createSharedSecretAuth({
  header: "x-seniorhealth-signature",
  secret: () => env.SENIORHEALTH_WEBHOOK_SECRET,
  envName: "SENIORHEALTH_WEBHOOK_SECRET",
  label: "Senior Health webhook",
});

/**
 * Auth for AffordablePlan lead intake (`x-affordableplan-signature`).
 *
 * The site's Next.js server route sends its secret verbatim, and only from the
 * server -- the browser never sees it, so it is not a public key on a write
 * endpoint. Same limit as the others: a static secret proves who is calling,
 * not that the body was not altered on the way.
 */
export const affordablePlanWebhookAuth = createSharedSecretAuth({
  header: "x-affordableplan-signature",
  secret: () => env.AFFORDABLEPLAN_WEBHOOK_SECRET,
  envName: "AFFORDABLEPLAN_WEBHOOK_SECRET",
  label: "Affordable Plan webhook",
});

/**
 * Auth for Explore Auto Insurance lead intake (`x-autoinsurance-signature`).
 *
 * The site is static HTML; its one server-side piece is a Vercel serverless
 * function (`api/lead.js`) that holds this secret and forwards the form. The
 * browser never sees it. Same limit as the others: a static secret proves who
 * is calling, not that the body was not altered on the way.
 */
export const autoInsuranceWebhookAuth = createSharedSecretAuth({
  header: "x-autoinsurance-signature",
  secret: () => env.AUTOINSURANCE_WEBHOOK_SECRET,
  envName: "AUTOINSURANCE_WEBHOOK_SECRET",
  label: "Auto Insurance webhook",
});

/**
 * Auth for Disability Benefit Helps lead intake (`x-socialsecurity-signature`).
 *
 * Same arrangement as Auto Insurance: the site is static HTML, and its Vercel
 * serverless function (`api/lead.js`) holds this secret and forwards the free
 * case review form. The browser never sees it. A static secret proves who is
 * calling, not that the body was not altered on the way.
 */
export const socialSecurityWebhookAuth = createSharedSecretAuth({
  header: "x-socialsecurity-signature",
  secret: () => env.SOCIALSECURITY_WEBHOOK_SECRET,
  envName: "SOCIALSECURITY_WEBHOOK_SECRET",
  label: "Social Security webhook",
});

