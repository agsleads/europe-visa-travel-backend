import { z } from "zod";

/**
 * The API's contract for an enquiry.
 *
 * This intentionally re-validates everything the Next.js Server Action already
 * validated. The API is a separate trust boundary: it must be correct when
 * called by something other than that action — a retry job, a second front
 * end, curl. Validating only at the edge you happen to control today is how
 * malformed rows get in tomorrow.
 */

/** Rejects header-injection payloads, which matter once values reach an email. */
const noControlChars = (v: string) => !/[\r\n\t\f\v\0]/.test(v);

const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Please keep this under ${max} characters.`)
    .refine(noControlChars, "Please remove any line breaks from this field.");

/**
 * Choice fields are checked as non-empty bounded strings rather than against a
 * hard-coded country list. The list is owned by the frontend (lib/contact.ts)
 * and rolls — the Schengen area gains members, the copy gets reworded. Pinning
 * a duplicate list here would mean a frontend content edit silently starts
 * rejecting real enquiries at the API, and a *lost enquiry* is a far worse
 * failure than an unexpected string in a column an operator reads by eye.
 * The Server Action still enforces the exact option list at the edge.
 */
export const createEnquirySchema = z.object({
  name: shortText(100).pipe(z.string().min(2, "Please enter your name.")),

  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Please enter your email address.")
    .max(254, "That email address is too long.")
    .refine(noControlChars, "Please remove any line breaks from this field.")
    .pipe(z.string().email("Please enter a valid email address.")),

  /* Permissive by design: international formats vary more than any regex a
     marketing form should enforce, and rejecting a valid number costs more
     than accepting a malformed one a human will read. */
  phone: shortText(30)
    .optional()
    .default("")
    .refine(
      (v) => v === "" || /^[+()\d][\d\s().-]{5,}$/.test(v),
      "Please enter a valid phone number, or leave this blank.",
    )
    // Empty string and "absent" mean the same thing; normalise to NULL so the
    // column has one representation of "no phone number".
    .transform((v) => (v === "" ? null : v)),

  destination: shortText(100).pipe(z.string().min(1, "Please choose a destination.")),
  visaType: shortText(100).pipe(z.string().min(1, "Please choose a visa type.")),
  travelMonth: shortText(40).pipe(z.string().min(1, "Please choose an approximate travel month.")),

  message: z
    .string()
    .trim()
    .min(10, "Please tell us a little more — at least 10 characters.")
    .max(2000, "Please keep your message under 2000 characters."),

  /* Must be explicitly true. `z.coerce.boolean()` would turn the string
     "false" into `true`, which for a consent flag is a compliance bug, so the
     accepted forms are enumerated instead. */
  consent: z
    .union([z.boolean(), z.literal("true"), z.literal("on")])
    .transform((v) => v === true || v === "true" || v === "on")
    .refine((v) => v, "Consent to the privacy notice is required."),

  /** Set by the caller, never by the browser. */
  source: shortText(50).optional().default("website"),
  clientHash: shortText(64).optional().nullable().default(null),
  userAgent: shortText(400).optional().nullable().default(null),
});

export type CreateEnquiryInput = z.input<typeof createEnquirySchema>;
export type CreateEnquiry = z.output<typeof createEnquirySchema>;

/* ------------------------------------------------------------- lead state */

/** The CRM pipeline, in order. `converted` and `lost` are terminal. */
export const ENQUIRY_STATUSES = ["new", "contacted", "qualified", "proposal", "converted", "lost"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const ENQUIRY_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type EnquiryPriority = (typeof ENQUIRY_PRIORITIES)[number];

export const CONTACT_CHANNELS = ["call", "email", "whatsapp"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const ACTIVITY_TYPES = [
  "created",
  "assigned",
  "unassigned",
  "status_changed",
  "priority_changed",
  "call",
  "email",
  "whatsapp",
  "note_added",
  "follow_up_added",
  "follow_up_completed",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Who performed a write, as asserted by the calling CRM server.
 *
 * Attribution, not authorisation: this service holds no user directory, so it
 * records the identity the API-key holder vouches for and nothing more. Both
 * halves are optional — a write with no actor is recorded as the system.
 */
export interface Actor {
  id: string | null;
  name: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, name: null };

/** An opaque CRM user id plus the display name stored beside it. */
const userId = shortText(64).pipe(z.string().min(1, "A user id is required."));
const userName = shortText(100).pipe(z.string().min(1, "A user name is required."));

/** Empty query values mean "no filter", never "match the empty string". */
const optionalFilter = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date.")
  .transform((v) => (v === undefined ? undefined : new Date(v)));

export const ENQUIRY_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "lastContactAt",
  "nextFollowUpAt",
  "name",
  "destination",
  "visaType",
  "status",
  "priority",
] as const;
export type EnquirySortField = (typeof ENQUIRY_SORT_FIELDS)[number];

export const listEnquiriesSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES).optional(),
  priority: z.enum(ENQUIRY_PRIORITIES).optional(),
  /** A CRM user id, or the literal `unassigned` for the unowned queue. */
  assignedTo: optionalFilter(64),
  destination: optionalFilter(100),
  visaType: optionalFilter(100),

  /**
   * Free-text search across reference, name, email, phone, destination, visa
   * type and message.
   *
   * Bounded and trimmed, and empty normalises to `undefined` so `?q=` behaves
   * as "no filter" rather than as a search for the empty string — which would
   * otherwise match every row and read as a broken filter.
   */
  q: z
    .string()
    .trim()
    .max(100, "Search terms are limited to 100 characters.")
    .optional()
    .transform((v) => (v ? v : undefined)),

  /** Inclusive bounds on `created_at`. A bare date in `to` covers that whole day. */
  from: optionalDate,
  to: optionalDate,

  sort: z.enum(ENQUIRY_SORT_FIELDS).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),

  // Bounded: an unbounded `limit` is a trivial way to pull the whole table
  // into memory in one request.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListEnquiriesQuery = z.output<typeof listEnquiriesSchema>;

export const enquiryStatsSchema = z.object({
  assignedTo: optionalFilter(64),
  from: optionalDate,
  to: optionalDate,
});

export type EnquiryStatsQuery = z.output<typeof enquiryStatsSchema>;

export const updateEnquiryStatusSchema = z.object({ status: z.enum(ENQUIRY_STATUSES) });

/** PATCH /:id — the lead fields an operator may change. At least one is required. */
export const updateEnquirySchema = z
  .object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    priority: z.enum(ENQUIRY_PRIORITIES).optional(),
  })
  .refine((v) => v.status !== undefined || v.priority !== undefined, {
    message: "Provide a status or a priority to update.",
    path: ["_"],
  });

export type UpdateEnquiry = z.output<typeof updateEnquirySchema>;

/** `assignee: null` unassigns. */
const assigneeSchema = z.union([z.object({ id: userId, name: userName }), z.null()]);

export const assignEnquirySchema = z.object({ assignee: assigneeSchema });

export const bulkAssignEnquiriesSchema = z.object({
  ids: z
    .array(z.coerce.number().int().positive())
    .min(1, "Select at least one enquiry.")
    .max(500, "Assign at most 500 enquiries at a time.")
    .transform((ids) => [...new Set(ids)]),
  assignee: assigneeSchema,
});

export type Assignee = { id: string; name: string };

export const logContactSchema = z.object({ channel: z.enum(CONTACT_CHANNELS) });

export const noteBodySchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Write a note before saving.")
    .max(2000, "Notes are limited to 2000 characters."),
});

export const createFollowUpSchema = z.object({
  title: shortText(120).pipe(z.string().min(1, "Describe the follow-up.")),
  dueAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 timestamp.")
    .transform((v) => new Date(v)),
});

export const updateFollowUpSchema = z.object({ completed: z.boolean() });

export const listFollowUpsSchema = z.object({
  assignedTo: optionalFilter(64),
  /** `true` returns only follow-ups still to do. */
  open: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListFollowUpsQuery = z.output<typeof listFollowUpsSchema>;

export const recentActivitySchema = z.object({
  assignedTo: optionalFilter(64),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type RecentActivityQuery = z.output<typeof recentActivitySchema>;

export const enquiryIdSchema = z.object({
  id: z.coerce.number().int().positive("Enquiry id must be a positive integer."),
});

export const noteIdSchema = enquiryIdSchema.extend({
  noteId: z.coerce.number().int().positive("Note id must be a positive integer."),
});

export const followUpIdSchema = enquiryIdSchema.extend({
  followUpId: z.coerce.number().int().positive("Follow-up id must be a positive integer."),
});

/* ------------------------------------------------------------ persisted shapes */

/** The persisted shape, in application casing. */
export interface Enquiry {
  id: number;
  reference: string;
  name: string;
  email: string;
  phone: string | null;
  destination: string;
  visaType: string;
  travelMonth: string;
  message: string;
  consent: boolean;
  consentedAt: Date | null;
  status: EnquiryStatus;
  priority: EnquiryPriority;
  assignedTo: Assignee | null;
  assignedAt: Date | null;
  lastContactAt: Date | null;
  /** The earliest open follow-up, derived — never stored. */
  nextFollowUpAt: Date | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnquiryActivity {
  id: number;
  enquiryId: number;
  /** The enquirer's name, present on cross-enquiry feeds. */
  enquiryName?: string;
  type: ActivityType;
  description: string;
  actor: Actor;
  createdAt: Date;
}

export interface EnquiryNote {
  id: number;
  enquiryId: number;
  content: string;
  author: Actor;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnquiryFollowUp {
  id: number;
  enquiryId: number;
  enquiryName?: string;
  title: string;
  dueAt: Date;
  completed: boolean;
  completedAt: Date | null;
  createdBy: Actor;
  createdAt: Date;
}

export interface AssigneeStats {
  assignedTo: Assignee;
  total: number;
  /** Past the `new` stage: someone has been in touch. */
  contacted: number;
  converted: number;
  lost: number;
}

/**
 * Counts for the CRM and admin dashboards.
 *
 * Computed in the database rather than by counting a fetched page: a panel
 * must show the size of the whole pipeline, and a count derived from a
 * paginated response is only ever the size of that page.
 */
export interface EnquiryStats {
  total: number;
  /** Every status is present, zero included — the UI renders a fixed set of
   *  tiles and a missing key would render as a gap rather than as "none". */
  byStatus: Record<EnquiryStatus, number>;
  byPriority: Record<EnquiryPriority, number>;
  assigned: number;
  unassigned: number;
  /** Arrivals in the trailing week — the "is it busy?" number. */
  last7Days: number;
  /** The week before that, so a dashboard can show the trend. */
  previous7Days: number;
  /** Follow-ups still to do on the enquiries in scope. */
  openFollowUps: number;
  byDestination: { destination: string; total: number; converted: number }[];
  byVisaType: { visaType: string; total: number; converted: number }[];
  byAssignee: AssigneeStats[];
  /** One entry per calendar month in range, oldest first, zero-filled. */
  monthly: { month: string; total: number; converted: number }[];
}

/** Distinct values for filter controls. */
export interface EnquiryFacets {
  destinations: string[];
  visaTypes: string[];
}
