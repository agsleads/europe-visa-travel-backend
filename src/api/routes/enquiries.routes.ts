import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { validate } from "@/api/middleware/validate";
import { writeLimiter } from "@/api/middleware/rateLimit";
import {
  createEnquirySchema,
  enquiryIdSchema,
  listEnquiriesSchema,
  updateEnquiryStatusSchema,
  type CreateEnquiry,
  type Enquiry,
  type ListEnquiriesQuery,
} from "@/domain/enquiry.schema";
import { createEnquiryService, type EnquiryService } from "@/services/enquiry.service";

/**
 * The public representation of an enquiry.
 *
 * Explicit rather than `res.json(enquiry)`: a serialiser that spreads the row
 * silently starts publishing every column someone later adds. `client_hash`
 * and `user_agent` are never selected into the domain object and never leave
 * the database.
 */
function present(enquiry: Enquiry) {
  return {
    id: enquiry.id,
    reference: enquiry.reference,
    name: enquiry.name,
    email: enquiry.email,
    phone: enquiry.phone,
    destination: enquiry.destination,
    visaType: enquiry.visaType,
    travelMonth: enquiry.travelMonth,
    message: enquiry.message,
    status: enquiry.status,
    source: enquiry.source,
    createdAt: enquiry.createdAt.toISOString(),
    updatedAt: enquiry.updatedAt.toISOString(),
  };
}

export function enquiriesRouter(service: EnquiryService = createEnquiryService()): Router {
  const router = Router();

  /**
   * POST /api/v1/enquiries — create an enquiry.
   *
   * 201 with the reference the enquirer is shown. The response deliberately
   * carries only `id` and `reference`: the caller already holds the payload,
   * and echoing personal data back widens the surface for nothing.
   */
  router.post(
    "/",
    writeLimiter,
    apiKeyAuth,
    validate(createEnquirySchema),
    asyncHandler(async (req, res) => {
      const enquiry = await service.create(req.body as CreateEnquiry);
      res
        .status(201)
        .location(`/api/v1/enquiries/${enquiry.id}`)
        .json({
          data: {
            id: enquiry.id,
            reference: enquiry.reference,
            createdAt: enquiry.createdAt.toISOString(),
          },
        });
    }),
  );

  /*
   * Everything below reads personal data.
   *
   * These are the operator-facing endpoints, and they carry the same shared
   * API key as the write path. That remains correct because no human ever
   * holds the key: the admin panel is server-rendered by Next.js, which
   * authenticates the operator against its own session cookie *first* and only
   * then calls this API from the server. The browser never sees the key, so
   * the key is not acting as a human authorisation model — the session in
   * front of it is.
   *
   * TODO(ops): that gate is a single shared credential (see lib/admin/auth.ts
   * in the frontend). The moment a second person needs their own login, or an
   * action needs attributing to a named operator, this needs per-user identity
   * and an access log — at which point the caller's identity should be passed
   * through to here rather than inferred.
   */
  /**
   * GET /api/v1/enquiries/stats — inbox counts for the admin dashboard.
   *
   * Registered BEFORE `/:id`. Express matches in declaration order, so with
   * these the other way round "stats" would be captured as an id and the
   * request would fail validation with a 422 rather than reaching this
   * handler — a bug that only shows up once the route exists.
   */
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
    validate(listEnquiriesSchema, "query"),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(req.query as unknown as ListEnquiriesQuery);
      res.json({ data: items.map(present), pagination });
    }),
  );

  router.get(
    "/:id",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as { id: number };
      res.json({ data: present(await service.getById(id)) });
    }),
  );

  router.patch(
    "/:id/status",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(updateEnquiryStatusSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as { id: number };
      const { status } = req.body as { status: Enquiry["status"] };
      res.json({ data: present(await service.updateStatus(id, status)) });
    }),
  );

  return router;
}
