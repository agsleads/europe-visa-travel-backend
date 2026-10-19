import { Router, type Request } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { validate } from "@/api/middleware/validate";
import { writeLimiter } from "@/api/middleware/rateLimit";
import {
  assignEnquirySchema,
  bulkAssignEnquiriesSchema,
  createEnquirySchema,
  createFollowUpSchema,
  enquiryIdSchema,
  enquiryStatsSchema,
  followUpIdSchema,
  listEnquiriesSchema,
  listFollowUpsSchema,
  logContactSchema,
  noteBodySchema,
  noteIdSchema,
  recentActivitySchema,
  updateEnquirySchema,
  updateEnquiryStatusSchema,
  updateFollowUpSchema,
  type Actor,
  type Assignee,
  type ContactChannel,
  type CreateEnquiry,
  type Enquiry,
  type EnquiryActivity,
  type EnquiryFollowUp,
  type EnquiryNote,
  type EnquiryStatsQuery,
  type ListEnquiriesQuery,
  type ListFollowUpsQuery,
  type RecentActivityQuery,
  type UpdateEnquiry,
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
    priority: enquiry.priority,
    assignedTo: enquiry.assignedTo,
    assignedAt: enquiry.assignedAt?.toISOString() ?? null,
    lastContactAt: enquiry.lastContactAt?.toISOString() ?? null,
    nextFollowUpAt: enquiry.nextFollowUpAt?.toISOString() ?? null,
    source: enquiry.source,
    createdAt: enquiry.createdAt.toISOString(),
    updatedAt: enquiry.updatedAt.toISOString(),
  };
}

function presentActivity(activity: EnquiryActivity) {
  return {
    id: activity.id,
    enquiryId: activity.enquiryId,
    ...(activity.enquiryName !== undefined && { enquiryName: activity.enquiryName }),
    type: activity.type,
    description: activity.description,
    actor: activity.actor,
    createdAt: activity.createdAt.toISOString(),
  };
}

function presentNote(note: EnquiryNote) {
  return {
    id: note.id,
    enquiryId: note.enquiryId,
    content: note.content,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function presentFollowUp(followUp: EnquiryFollowUp) {
  return {
    id: followUp.id,
    enquiryId: followUp.enquiryId,
    ...(followUp.enquiryName !== undefined && { enquiryName: followUp.enquiryName }),
    title: followUp.title,
    dueAt: followUp.dueAt.toISOString(),
    completed: followUp.completed,
    completedAt: followUp.completedAt?.toISOString() ?? null,
    createdBy: followUp.createdBy,
    createdAt: followUp.createdAt.toISOString(),
  };
}

/**
 * Bounded, single-line header value, or null.
 *
 * Values are percent-encoded UTF-8: HTTP header values are Latin-1 on the
 * wire, so a name like "Zoë Ng" or "陈伟" cannot travel raw. A value that is
 * not valid percent-encoding (a bare "50%") is taken literally.
 */
function headerValue(req: Request, name: string, max: number): string | null {
  const raw = req.get(name)?.trim();
  if (!raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded; use as sent.
  }
  if (/[\r\n\t\f\v\0]/.test(value)) return null;
  return value.trim().slice(0, max) || null;
}

/**
 * The CRM user a write is attributed to, from `x-actor-id` / `x-actor-name`.
 *
 * Asserted by the API-key holder, not proven: this service has no user
 * directory. It is recorded in the activity history so a timeline reads
 * "Sarah Chen changed the status", and is never used to grant access.
 */
function actorOf(req: Request): Actor {
  return { id: headerValue(req, "x-actor-id", 64), name: headerValue(req, "x-actor-name", 100) };
}

type IdParams = { id: number };

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
   * Everything below reads or works personal data.
   *
   * These are the operator-facing endpoints used by the CRM and the EVC admin
   * console, and they carry the same shared API key as the write path. That
   * remains correct because no human ever holds the key: each console
   * authenticates its operator against its own session first and only then
   * calls this API from its server. The browser never sees the key.
   *
   * Per-user identity for attribution arrives in `x-actor-id` / `x-actor-name`
   * (see `actorOf`). Access control — which rep may see which lead — is the
   * calling console's responsibility; this service trusts the key holder.
   */

  /*
   * Fixed paths are registered BEFORE `/:id`. Express matches in declaration
   * order, so with these the other way round "stats" would be captured as an
   * id and the request would fail validation with a 422 rather than reaching
   * its handler — a bug that only shows up once the route exists.
   */

  /** GET /stats — pipeline counts. `?assignedTo=&from=&to=` scope every figure. */
  router.get(
    "/stats",
    apiKeyAuth,
    validate(enquiryStatsSchema, "query"),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.stats(req.query as unknown as EnquiryStatsQuery) });
    }),
  );

  /** GET /facets — distinct destinations and visa types, for filter controls. */
  router.get(
    "/facets",
    apiKeyAuth,
    asyncHandler(async (_req, res) => {
      res.json({ data: await service.facets() });
    }),
  );

  /** GET /follow-ups — across enquiries. `?assignedTo=&open=true&limit=`. */
  router.get(
    "/follow-ups",
    apiKeyAuth,
    validate(listFollowUpsSchema, "query"),
    asyncHandler(async (req, res) => {
      const items = await service.allFollowUps(req.query as unknown as ListFollowUpsQuery);
      res.json({ data: items.map(presentFollowUp) });
    }),
  );

  /** GET /activity — the latest activity across enquiries. `?assignedTo=&limit=`. */
  router.get(
    "/activity",
    apiKeyAuth,
    validate(recentActivitySchema, "query"),
    asyncHandler(async (req, res) => {
      const items = await service.recentActivities(req.query as unknown as RecentActivityQuery);
      res.json({ data: items.map(presentActivity) });
    }),
  );

  /** POST /bulk-assign — `{ ids, assignee }`; `assignee: null` unassigns. */
  router.post(
    "/bulk-assign",
    apiKeyAuth,
    validate(bulkAssignEnquiriesSchema),
    asyncHandler(async (req, res) => {
      const { ids, assignee } = req.body as { ids: number[]; assignee: Assignee | null };
      res.json({ data: await service.bulkAssign(ids, assignee, actorOf(req)) });
    }),
  );

  /**
   * GET / — a page of enquiries.
   *
   * `?status=&priority=&assignedTo=&destination=&visaType=&q=&from=&to=`
   * filter; `?sort=&order=` order; `?limit=&offset=` page.
   */
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
      const { id } = req.params as unknown as IdParams;
      res.json({ data: present(await service.getById(id)) });
    }),
  );

  /** PATCH /:id — `{ status?, priority? }`. Each change is recorded as activity. */
  router.patch(
    "/:id",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(updateEnquirySchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: present(await service.update(id, req.body as UpdateEnquiry, actorOf(req))) });
    }),
  );

  /** PATCH /:id/status — kept for callers that only move the status. */
  router.patch(
    "/:id/status",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(updateEnquiryStatusSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { status } = req.body as { status: Enquiry["status"] };
      res.json({ data: present(await service.updateStatus(id, status, actorOf(req))) });
    }),
  );

  /** PUT /:id/assignee — `{ assignee: { id, name } }` to assign or reassign, `null` to unassign. */
  router.put(
    "/:id/assignee",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(assignEnquirySchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { assignee } = req.body as { assignee: Assignee | null };
      res.json({ data: present(await service.assign(id, assignee, actorOf(req))) });
    }),
  );

  /** POST /:id/contacts — `{ channel }`. Logs the outreach and stamps last contact. */
  router.post(
    "/:id/contacts",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(logContactSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { channel } = req.body as { channel: ContactChannel };
      res.status(201).json({ data: present(await service.logContact(id, channel, actorOf(req))) });
    }),
  );

  router.get(
    "/:id/activity",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: (await service.activities(id)).map(presentActivity) });
    }),
  );

  /* ---------------------------------------------------------------- notes */

  router.get(
    "/:id/notes",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: (await service.notes(id)).map(presentNote) });
    }),
  );

  router.post(
    "/:id/notes",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(noteBodySchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { content } = req.body as { content: string };
      res.status(201).json({ data: presentNote(await service.addNote(id, content, actorOf(req))) });
    }),
  );

  router.patch(
    "/:id/notes/:noteId",
    apiKeyAuth,
    validate(noteIdSchema, "params"),
    validate(noteBodySchema),
    asyncHandler(async (req, res) => {
      const { id, noteId } = req.params as unknown as { id: number; noteId: number };
      const { content } = req.body as { content: string };
      res.json({ data: presentNote(await service.updateNote(id, noteId, content)) });
    }),
  );

  router.delete(
    "/:id/notes/:noteId",
    apiKeyAuth,
    validate(noteIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id, noteId } = req.params as unknown as { id: number; noteId: number };
      await service.deleteNote(id, noteId);
      res.status(204).end();
    }),
  );

  /* ----------------------------------------------------------- follow-ups */

  router.get(
    "/:id/follow-ups",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: (await service.followUps(id)).map(presentFollowUp) });
    }),
  );

  router.post(
    "/:id/follow-ups",
    apiKeyAuth,
    validate(enquiryIdSchema, "params"),
    validate(createFollowUpSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const input = req.body as { title: string; dueAt: Date };
      res.status(201).json({ data: presentFollowUp(await service.addFollowUp(id, input, actorOf(req))) });
    }),
  );

  router.patch(
    "/:id/follow-ups/:followUpId",
    apiKeyAuth,
    validate(followUpIdSchema, "params"),
    validate(updateFollowUpSchema),
    asyncHandler(async (req, res) => {
      const { id, followUpId } = req.params as unknown as { id: number; followUpId: number };
      const { completed } = req.body as { completed: boolean };
      res.json({
        data: presentFollowUp(await service.setFollowUpCompleted(id, followUpId, completed, actorOf(req))),
      });
    }),
  );

  router.delete(
    "/:id/follow-ups/:followUpId",
    apiKeyAuth,
    validate(followUpIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id, followUpId } = req.params as unknown as { id: number; followUpId: number };
      await service.deleteFollowUp(id, followUpId);
      res.status(204).end();
    }),
  );

  return router;
}
