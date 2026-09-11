import { Router } from "express";

import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { asyncHandler } from "@/api/middleware/asyncHandler";
import { leadIntakeLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import { roadcoverWebhookAuth } from "@/api/middleware/webhookAuth";
import {
  leadIdSchema,
  leadWebhookSchema,
  listLeadsSchema,
  updateLeadStatusSchema,
  type Lead,
  type LeadDetail,
  type LeadListItem,
  type LeadStatus,
  type LeadWebhook,
  type ListLeadsQuery,
} from "@/domain/lead.schema";
import { createLeadService, type LeadService } from "@/services/lead.service";

/**
 * Road Cover lead intake and the operator-facing reads.
 *
 * The two halves carry different credentials on purpose. The intake is called
 * by someone else's website and authenticates with `x-roadcover-signature`;
 * everything below it is called by our own admin console and authenticates with
 * `x-api-key`. A caller who can post a lead cannot read the inbox.
 */

/** The list representation. Explicit, so a new column is never published by accident. */
function present(lead: Lead) {
  return {
    id: lead.id,
    submittedAt: lead.submittedAt.toISOString(),
    zip: lead.zip,
    stateSelected: lead.stateSelected,
    stateFromZip: lead.stateFromZip,
    vehicleYear: lead.vehicleYear,
    currentlyInsured: lead.currentlyInsured,
    firstName: lead.firstName,
    lastName: lead.lastName,
    age: lead.age,
    phoneRaw: lead.phoneRaw,
    phoneE164: lead.phoneE164,
    email: lead.email,
    status: lead.status,
    isRepeat: lead.isRepeat,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

/**
 * The list representation: the lead plus the two attribution fields an operator
 * triages on. The rest of the attribution panel is a detail-view concern and is
 * not worth a join per row on a list that is mostly scanned, not read.
 */
function presentListItem(lead: LeadListItem) {
  return { ...present(lead), utmSource: lead.utmSource, utmCampaign: lead.utmCampaign };
}

/** The detail representation: the list fields plus consent, attribution and the raw body. */
function presentDetail(lead: LeadDetail) {
  return {
    ...present(lead),
    relatedLeadIds: lead.relatedLeadIds,
    rawPayload: lead.rawPayload,
    consent: {
      // Verbatim. Never truncated for display -- the whole value is the record.
      text: lead.consent.text,
      version: lead.consent.version,
      consentedAt: lead.consent.consentedAt.toISOString(),
      ipAddress: lead.consent.ipAddress,
      userAgent: lead.consent.userAgent,
      landingPageUrl: lead.consent.landingPageUrl,
      trustedFormCertUrl: lead.consent.trustedFormCertUrl,
    },
    attribution: {
      utmSource: lead.attribution.utmSource,
      utmMedium: lead.attribution.utmMedium,
      utmCampaign: lead.attribution.utmCampaign,
      utmTerm: lead.attribution.utmTerm,
      utmContent: lead.attribution.utmContent,
      gclid: lead.attribution.gclid,
      fbclid: lead.attribution.fbclid,
      referrer: lead.attribution.referrer,
      sessionId: lead.attribution.sessionId,
      formStartedAt: lead.attribution.formStartedAt?.toISOString() ?? null,
      formCompletedAt: lead.attribution.formCompletedAt.toISOString(),
    },
  };
}

export function leadsRouter(service: LeadService = createLeadService()): Router {
  const router = Router();

  /**
   * POST /api/v1/roadcover/leads — intake from roadcover.us.
   *
   * The response body is `{ ok, id }` rather than this API's usual `{ data }`
   * envelope. That is deliberate: the shape is the producer's contract, it is
   * already deployed on a site we do not own, and matching a house style is not
   * worth a coordinated release with someone else's codebase.
   *
   * Status codes carry the meaning the producer acts on:
   *   201 — recorded.
   *   200 — already recorded (a replay). Same id, nothing written.
   *   401/422 — the caller's problem; retrying will not help.
   *   503 — ours; the row was not written and a retry is worth making.
   *
   * Never 5xx for bad input: the producer shows the consumer a retry on any
   * non-2xx, and a retry of a malformed body only produces a second one.
   */
  router.post(
    "/",
    leadIntakeLimiter,
    roadcoverWebhookAuth,
    /* The raw body is captured before `validate` replaces `req.body` with the
       parsed value. `raw_payload` must be the original: unknown keys and
       untruncated audit strings are exactly what it exists to preserve. */
    (req, _res, next) => {
      (req as { rawLeadBody?: unknown }).rawLeadBody = req.body;
      next();
    },
    validate(leadWebhookSchema),
    asyncHandler(async (req, res) => {
      const rawBody = (req as { rawLeadBody?: unknown }).rawLeadBody;
      const { lead, duplicate } = await service.record(req.body as LeadWebhook, rawBody);

      res
        .status(duplicate ? 200 : 201)
        .location(`/api/v1/roadcover/leads/${lead.id}`)
        .json({ ok: true, id: lead.id, duplicate });
    }),
  );

  /*
   * Everything below reads consumer personal data and TCPA consent records.
   *
   * Same shared API key as the enquiry reads, and correct for the same reason:
   * no human holds it. The admin console is server-rendered by Next.js, which
   * authenticates the operator against its own session cookie first and only
   * then calls this API from the server. The key is not the authorisation
   * model; the session in front of it is.
   */

  /** Registered before `/:id` — Express matches in declaration order, so the
   *  other way round "stats" is captured as an id and 422s. */
  router.get(
    "/stats",
    apiKeyAuth,
    asyncHandler(async (_req, res) => {
      res.json({ data: await service.stats() });
    }),
  );

  router.get(
    "/",
    apiKeyAuth,
    validate(listLeadsSchema, "query"),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(req.query as unknown as ListLeadsQuery);
      res.json({ data: items.map(presentListItem), pagination });
    }),
  );

  router.get(
    "/:id",
    apiKeyAuth,
    validate(leadIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as { id: number };
      res.json({ data: presentDetail(await service.getById(id)) });
    }),
  );

  router.patch(
    "/:id/status",
    apiKeyAuth,
    validate(leadIdSchema, "params"),
    validate(updateLeadStatusSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as { id: number };
      const { status } = req.body as { status: LeadStatus };
      res.json({ data: present(await service.updateStatus(id, status)) });
    }),
  );

  return router;
}
