import { Router } from "express";

import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { asyncHandler } from "@/api/middleware/asyncHandler";
import { requestIdOf } from "@/api/middleware/requestId";
import { onyxAvailabilityLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import { onyxUtilizationSchema, type OnyxUtilizationPayload } from "@/domain/onyx.schema";
import { logger } from "@/lib/logger";
import { createOnyxClient, type OnyxClient } from "@/services/onyx.client";

/*
 * Two views of the same Onyx utilization ping. Neither stores anything.
 *
 * POST /api/v1/onyx/utilization
 *   Onyx's answer verbatim, commercial terms included. Server-to-server only,
 *   and still behind `x-api-key`.
 *   200  { data: <Onyx's response> }
 *
 * POST /api/v1/onyx/availability
 *   The same ping, reduced to what a browser may see. PUBLIC - no API key.
 *   200  { data: { available } }
 *
 * `availability` is deliberately unauthenticated. It is called from a static
 * lead form that has no server of its own, so the only way to authenticate it
 * would be to ship a key in the page -- and a key readable by every visitor is
 * not a key, it is an announcement. Better an endpoint that is honestly public
 * and rate limited than one that pretends to be guarded.
 *
 * What stops abuse instead:
 *   - `onyxAvailabilityLimiter`, 10/minute per IP. This is the only protection
 *     on the route, so do not remove it without replacing it.
 *   - CORS, which allowlists the form's origin for browsers.
 *   - `publicView`, which withholds the transfer number and our buy rate.
 *
 * What it does NOT stop: a script calling it directly. CORS binds browsers,
 * not curl. Each call still spends our Onyx credential, so watch the Onyx
 * spend after this goes live and tighten the limit if it is being farmed.
 *
 * Both share the failure cases:
 *   422  The body failed validation here; Onyx was not called.
 *   502  Onyx refused it, or could not be reached.
 *        Body: { error: { code, message, onyxStatus, onyxResponse, requestId } }
 *   503  EVC_ONYX_API_KEY is not set on this server.
 *   504  Onyx did not answer in time.
 */

/**
 * Onyx answers the ping with the transfer number and its commercial terms:
 *
 *   { phone_number, available, duration, bid, billing_type }
 *
 * `bid` is what we pay per call, and `duration` and `billing_type` are the
 * terms that price it. A lead form runs in a browser, so anything it receives
 * is readable in the network tab by anyone who opens the page — publishing our
 * buy rate to every visitor and to competitors.
 *
 * `phone_number` is withheld on the same grounds. The browser's question is
 * only "may I transfer this Lead", which a boolean answers; the number the
 * transfer goes to is routing we hold, not something to hand to whoever loads
 * the page. Server-to-server callers that do need it use /utilization.
 *
 * Non-object bodies (Onyx sent text, or nothing) collapse to `available: false`:
 * a response we cannot read is not a confirmed yes, and the safe answer to an
 * unreadable reply is no.
 */
function publicView(body: unknown): { available: boolean } {
  if (typeof body !== "object" || body === null) {
    return { available: false };
  }

  const { available } = body as Record<string, unknown>;

  // `=== true` and not a truthy check: a string "true", or any other shape
  // Onyx might send, is not a confirmed yes.
  return { available: available === true };
}

export function onyxRouter(client: OnyxClient = createOnyxClient()): Router {
  const router = Router();

  /* One ping, two renderings of the result. The difference between the routes
     is only what the 200 body carries, so the call, the validation and every
     failure path are shared rather than written twice and drifting apart. */
  const handler = (shape: (body: unknown) => unknown) =>
    asyncHandler(async (req, res) => {
      const payload = req.body as OnyxUtilizationPayload;
      const result = await client.postUtilization(payload);

      // Identifiers only — the payload is a person's name, phone and address.
      logger.info(
        { externalId: payload.external_id, onyxStatus: result.status },
        result.ok ? "Onyx utilization accepted" : "Onyx utilization refused",
      );

      if (result.ok) {
        res.status(200).json({ data: shape(result.body) });
        return;
      }

      /* Answered directly rather than thrown: Onyx's body is the useful part of
         a refusal, and routing it through the error handler would also write it
         into the error log, where it may echo the person's details back. 502,
         not Onyx's own status — a 401 from Onyx means OUR Onyx key is wrong,
         and passing that through would read as the caller's key being wrong. */
      res.status(502).json({
        error: {
          code: "onyx_rejected",
          message: `Onyx refused the request with HTTP ${result.status}.`,
          onyxStatus: result.status,
          onyxResponse: result.body,
          requestId: requestIdOf(req),
        },
      });
    });

  router.post(
    "/utilization",
    apiKeyAuth,
    validate(onyxUtilizationSchema),
    handler((body) => body),
  );

  /* No apiKeyAuth: see the note at the top of this file. The limiter is not
     optional here -- it is what the API key used to be. */
  router.post(
    "/availability",
    onyxAvailabilityLimiter,
    validate(onyxUtilizationSchema),
    handler(publicView),
  );

  return router;
}
