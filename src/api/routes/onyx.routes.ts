import { Router } from "express";

import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { asyncHandler } from "@/api/middleware/asyncHandler";
import { requestIdOf } from "@/api/middleware/requestId";
import { validate } from "@/api/middleware/validate";
import { onyxUtilizationSchema, type OnyxUtilizationPayload } from "@/domain/onyx.schema";
import { logger } from "@/lib/logger";
import { createOnyxClient, type OnyxClient } from "@/services/onyx.client";

/**
 * POST /api/v1/onyx/utilization — forwards the body to Onyx and returns Onyx's answer.
 *
 * Nothing is stored. Authenticated with the same `x-api-key` as the rest of this
 * API: this endpoint spends a paid third-party credential, so leaving it open
 * would let anyone push data into Onyx under our account.
 *
 *   200  Onyx accepted it.       Body: { data: <Onyx's response> }
 *   422  The body failed validation here; Onyx was not called.
 *   502  Onyx refused it, or could not be reached.
 *        Body: { error: { code, message, onyxStatus, onyxResponse, requestId } }
 *   503  ONYX_API_KEY is not set on this server.
 *   504  Onyx did not answer in time.
 */
export function onyxRouter(client: OnyxClient = createOnyxClient()): Router {
  const router = Router();

  router.post(
    "/utilization",
    apiKeyAuth,
    validate(onyxUtilizationSchema),
    asyncHandler(async (req, res) => {
      const payload = req.body as OnyxUtilizationPayload;
      const result = await client.postUtilization(payload);

      // Identifiers only — the payload is a person's name, phone and address.
      logger.info(
        { externalId: payload.external_id, onyxStatus: result.status },
        result.ok ? "Onyx utilization accepted" : "Onyx utilization refused",
      );

      if (result.ok) {
        res.status(200).json({ data: result.body });
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
    }),
  );

  return router;
}
