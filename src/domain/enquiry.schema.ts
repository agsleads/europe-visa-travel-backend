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

export const ENQUIRY_STATUSES = ["new", "in_progress", "responded", "closed", "spam"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const listEnquiriesSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES).optional(),

  /**
   * Free-text search across reference, name, email, destination and message.
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

  // Bounded: an unbounded `limit` is a trivial way to pull the whole table
  // into memory in one request.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListEnquiriesQuery = z.output<typeof listEnquiriesSchema>;

export const updateEnquiryStatusSchema = z.object({ status: z.enum(ENQUIRY_STATUSES) });

export const enquiryIdSchema = z.object({
  id: z.coerce.number().int().positive("Enquiry id must be a positive integer."),
});

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
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Counts for the admin dashboard.
 *
 * Computed in the database rather than by counting a fetched page: the panel
 * must show the size of the whole inbox, and a count derived from a paginated
 * response is only ever the size of that page.
 */
export interface EnquiryStats {
  total: number;
  /** Every status is present, zero included — the UI renders a fixed set of
   *  tiles and a missing key would render as a gap rather than as "none". */
  byStatus: Record<EnquiryStatus, number>;
  /** Arrivals in the trailing week — the "is it busy?" number. */
  last7Days: number;
}
