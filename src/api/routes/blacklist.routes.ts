import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { requestIdOf } from "@/api/middleware/requestId";
import { blacklistLookupLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import { blacklistLookupSchema, type BlacklistLookupPayload } from "@/domain/blacklist.schema";
import { logger } from "@/lib/logger";
import { createBlacklistClient, type BlacklistClient } from "@/services/blacklist.client";

/*
 * POST /api/v1/blacklist/lookup
 *   Checks one phone number against the Blacklist Alliance databases.
 *   Stores nothing. PUBLIC - no API key.
 *
 *   Body  { phone: "2223334444" }   (punctuation and a leading +1 are fine)
 *   200   { data: <Blacklist Alliance's response> }
 *         e.g. { status: "success", message: "Good" | "Blacklisted" | ...,
 *                code: [...], wireless, phone, carrier?, ... }
 *
 * POST, not GET, although the upstream call is a GET: a phone number in our
 * query string would land in the access log of every hop in front of us.
 *
 * Public for the reason the Onyx routes are: the caller is a static page with
 * no server of its own, and a key shipped in that page is readable by anyone.
 * `blacklistLookupLimiter` and the CORS allowlist are its protection instead.
 * Each call spends a paid lookup, so watch usage after launch.
 *
 * Failure cases:
 *   422  The number failed validation here, or Blacklist Alliance rejected it
 *        as invalid. Body: the usual { error: { details: { fieldErrors } } }.
 *   502  Blacklist Alliance refused the request (a 403 there means OUR key is
 *        wrong), or could not be reached.
 *        Body: { error: { code, message, upstreamStatus, upstreamMessage, requestId } }
 *   503  BLACKLIST_ALLIANCE_API_KEY is not set on this server.
 *   504  Blacklist Alliance did not answer in time.
 */

export function blacklistRouter(client: BlacklistClient = createBlacklistClient()): Router {
  const router = Router();

  router.post(
    "/lookup",
    blacklistLookupLimiter,
    validate(blacklistLookupSchema),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as BlacklistLookupPayload;
      const result = await client.lookup(phone);

      const verdict =
        typeof result.body === "object" && result.body !== null
          ? (result.body as Record<string, unknown>).message
          : undefined;

      // The verdict and status only — the number itself is personal data.
      logger.info(
        { upstreamStatus: result.status, verdict },
        result.ok ? "Blacklist lookup answered" : "Blacklist lookup refused",
      );

      if (result.ok) {
        res.status(200).json({ data: result.body });
        return;
      }

      /* The provider's 422 is "invalid phone number": the caller's mistake, so
         it is reported in the same field-keyed shape as our own validation. */
      if (result.status === 422) {
        res.status(422).json({
          error: {
            code: "validation_failed",
            message: "Blacklist Alliance rejected the phone number.",
            details: {
              fieldErrors: { phone: result.errorMessage || "Blacklist Alliance says this number is invalid." },
            },
            requestId: requestIdOf(req),
          },
        });
        return;
      }

      /* 502, not the provider's own status — a 403 there means OUR key is
         wrong, and passing it through would read as the caller's fault. */
      res.status(502).json({
        error: {
          code: "blacklist_rejected",
          message: `Blacklist Alliance refused the request with HTTP ${result.status}.`,
          upstreamStatus: result.status,
          upstreamMessage:
            result.errorMessage || (typeof result.body === "string" ? result.body : null),
          requestId: requestIdOf(req),
        },
      });
    }),
  );

  return router;
}
