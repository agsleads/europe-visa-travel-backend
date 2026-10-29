import { Router, type Request, type Response } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { requestIdOf } from "@/api/middleware/requestId";
import { callGridBidLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import {
  callGridBidParamsSchema,
  callGridBidSchema,
  callGridConfirmSchema,
} from "@/domain/callgrid.schema";
import { logger } from "@/lib/logger";
import {
  createCallGridClient,
  type CallGridClient,
  type CallGridResponse,
} from "@/services/callgrid.client";

/*
 * CallGrid real-time bidding. Neither route stores anything. PUBLIC - no API key.
 *
 * POST /api/v1/callgrid/bid
 *   Body  { CallerId, InboundStateCode?, InboundZipCode?, pstn?, ...buyer extras }
 *         CallerId is brought to E.164; a 10-digit US number gets +1.
 *   200   { data: <CallGrid's response> }
 *
 * POST /api/v1/callgrid/bid/:bidId/confirm
 *   For Grids whose bids answer `confirmationRequired: true`: no SIP address
 *   or number is handed out until the bid is confirmed.
 *   Body  { CallerId?, ...extras }
 *   200   { data: <CallGrid's response> }
 *
 * 200 is not "won". CallGrid answers a rejected bid with HTTP 200 and a code
 * of 4001-4013 in the body; only `code` 1000 is a bid. A refusal is a real
 * answer to the question asked, so it passes through as 200 and the caller
 * reads `data.code`, rather than being dressed up as a server failure.
 *
 * WHAT THIS PUBLISHES. A winning bid carries `dynamicBid` (the price, USD) and
 * `dynamicSipAddress` / `dynamicPhoneNumber` (where to send the call). Public
 * for the reason the Onyx and Blacklist routes are — the caller is a static
 * page with no server of its own — so both are readable by anyone who finds
 * this URL. `callGridBidLimiter` and the CORS allowlist are its protection.
 *
 * Failure cases:
 *   422  The body failed validation here; CallGrid was not called.
 *   429  CallGrid's own rate limit for this Grid (its code 5001).
 *   502  CallGrid answered with some other HTTP error, or could not be reached.
 *        Body: { error: { code, message, upstreamStatus, upstreamResponse, requestId } }
 *   503  CALLGRID_GRID_ID is not set on this server.
 *   504  CallGrid did not answer in time.
 */

/** The fields worth a log line. Never the caller ID, the address or the number. */
function logFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const { id, code, dynamicBid, confirmationRequired } = body as Record<string, unknown>;
  return { bidId: id, callGridCode: code, dynamicBid, confirmationRequired };
}

function reply(req: Request, res: Response, result: CallGridResponse, event: string): void {
  logger.info({ upstreamStatus: result.status, ...logFields(result.body) }, event);

  if (result.ok) {
    res.status(200).json({ data: result.body });
    return;
  }

  /* CallGrid's limit is per Grid, set by the buyer, and shared by everyone
     using this server — so it is passed on as a 429 the caller can wait out,
     not a 502 that reads as an outage. */
  if (result.status === 429) {
    res.status(429).json({
      error: {
        code: "callgrid_rate_limited",
        message: "CallGrid's rate limit for this Grid was reached. Wait a moment and try again.",
        upstreamResponse: result.body,
        requestId: requestIdOf(req),
      },
    });
    return;
  }

  res.status(502).json({
    error: {
      code: "callgrid_rejected",
      message: `CallGrid refused the request with HTTP ${result.status}.`,
      upstreamStatus: result.status,
      upstreamResponse: result.body,
      requestId: requestIdOf(req),
    },
  });
}

export function callGridRouter(client: CallGridClient = createCallGridClient()): Router {
  const router = Router();

  /* No apiKeyAuth: see the note at the top of this file. The limiter is not
     optional — it is the whole of this route's protection. */
  router.post(
    "/bid",
    callGridBidLimiter,
    validate(callGridBidSchema),
    asyncHandler(async (req, res) => {
      const result = await client.bid(req.body as Record<string, unknown>);
      reply(req, res, result, "CallGrid bid answered");
    }),
  );

  router.post(
    "/bid/:bidId/confirm",
    callGridBidLimiter,
    validate(callGridBidParamsSchema, "params"),
    validate(callGridConfirmSchema),
    asyncHandler(async (req, res) => {
      const { bidId } = req.params as { bidId: string };
      const result = await client.confirm(bidId, req.body as Record<string, unknown>);
      reply(req, res, result, "CallGrid confirmation answered");
    }),
  );

  return router;
}
