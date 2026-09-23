import { createHash } from "node:crypto";
import { z } from "zod";

import {
  cappedText,
  isoDate,
  normaliseEmail,
  normalisePhone,
  nullableIsoDate,
} from "@/domain/shared";

/* Re-exported: these lived here first, and callers import them from this module. */
export { normaliseEmail, normalisePhone };

/**
 * The contract for a Road Cover lead.
 *
 * The producer (roadcover.us) already validates every answer on both the client
 * and its own server before it posts. This re-validates all of it anyway, for
 * the same reason the enquiry schema does: this API is a separate trust
 * boundary, and it must be correct when called by a replayed webhook, a second
 * producer, or curl.
 *
 * Two rules shape everything below, and they pull in opposite directions:
 *
 *   - The nine *answers* are rejected when invalid. They are the lead; a lead
 *     with a malformed phone number is not worth having.
 *   - The *audit and attribution* strings are truncated when they are too long,
 *     never rejected. A 3 kB referrer is not a reason to fail a submission --
 *     the producer treats any non-2xx as failure and shows the consumer a
 *     retry, so rejecting here loses a real lead over a marketing URL. The
 *     untruncated value survives verbatim in `raw_payload` regardless.
 */

/* ------------------------------------------------------------------ helpers */

/** Two-letter USPS code. Upper-cased so `fl` and `FL` are one value. */
const stateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Expected a two-letter state code.");

/* ------------------------------------------------------------------ answers */

/**
 * The nine answers, mirroring the producer's own `quoteAnswersSchema`.
 *
 * Every value arrives as a string, including `age` and `vehicleYear`. They are
 * kept as strings here and converted at the persistence boundary, so this
 * schema stays a description of what is on the wire.
 */
export const leadAnswersSchema = z.object({
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "Expected a five-digit ZIP code."),

  state: stateCode,

  vehicleYear: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Expected a four-digit vehicle year."),

  currentlyInsured: z.enum(["yes", "no"]),

  firstName: z.string().trim().min(1, "First name is required.").max(50),
  lastName: z.string().trim().min(1, "Last name is required.").max(50),

  age: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "Expected an age in whole years.")
    .refine((value) => {
      const age = Number(value);
      return age >= 16 && age <= 100;
    }, "Drivers must be between 16 and 100."),

  /* Arrives pre-masked as "(305) 555-0147". Validated on the ten digits inside
     it rather than on the mask, so a differently formatted but valid number
     from a future producer version is still accepted. */
  phone: z
    .string()
    .trim()
    .min(1, "A phone number is required.")
    .max(30)
    .refine((value) => normalisePhone(value) !== null, "Expected a ten-digit US phone number."),

  email: z.string().trim().toLowerCase().min(1).max(254).email("Expected a valid email address."),
});

export type LeadAnswers = z.infer<typeof leadAnswersSchema>;

/* ----------------------------------------------------------------- envelope */

export const leadWebhookSchema = z.object({
  receivedAt: isoDate,

  answers: leadAnswersSchema,

  /* Re-derived from the ZIP by the producer, and legitimately different from
     `answers.state` when the consumer overrode the select. Null means the ZIP
     prefix was not recognised. Both are persisted. */
  state: z
    .union([stateCode, z.null()])
    .nullish()
    .transform((value) => value ?? null),

  consent: z.object({
    /* Capped far above the ~700 characters the current wording runs to, and
       NOT truncated with `cappedText` -- this is the one string in the payload
       that is evidence. A silently shortened consent record would be worse
       than no record, so an implausible one is rejected outright. */
    text: z.string().min(1, "The consent text is required.").max(20_000),
    version: z.string().trim().min(1, "The consent version is required.").max(40),
    timestamp: isoDate,
  }),

  audit: z.object({
    ipAddress: cappedText(45),
    userAgent: cappedText(1_000),
    landingPageUrl: cappedText(2_048),
    referrer: cappedText(2_048),
    /* Required: it is half of the dedupe key. A submission without one cannot
       be deduplicated, and silently defaulting it would make every such
       submission collide with every other. */
    sessionId: z.string().trim().min(1, "A session id is required.").max(100),
    formStartedAt: nullableIsoDate,
    formCompletedAt: isoDate,
    trustedFormCertUrl: cappedText(2_048),
  }),

  attribution: z.object({
    utm_source: cappedText(200),
    utm_medium: cappedText(200),
    utm_campaign: cappedText(200),
    utm_term: cappedText(200),
    utm_content: cappedText(200),
    gclid: cappedText(500),
    fbclid: cappedText(500),
  }),
});

/* Unknown keys are stripped from the parsed value but survive in `raw_payload`,
   which is stored unmodified. That is what makes a producer that starts sending
   a tenth answer a forward-compatible change here rather than a 422 and a lost
   lead. */
export type LeadWebhook = z.output<typeof leadWebhookSchema>;
export type LeadWebhookInput = z.input<typeof leadWebhookSchema>;

/* --------------------------------------------------------------- normalising */

/**
 * The idempotency key: sha256 of the session and the completion timestamp.
 *
 * A session id alone is not enough -- one browser session can legitimately
 * submit twice, and treating the second as a duplicate would silently drop a
 * real lead. The pair identifies one *completion* of the form, which is what a
 * replay repeats and a genuine resubmission does not.
 */
export function deriveDedupeKey(sessionId: string, formCompletedAt: Date): string {
  return createHash("sha256")
    .update(`${sessionId}\n${formCompletedAt.toISOString()}`)
    .digest("hex");
}

/* -------------------------------------------------------------- persistence */

export const LEAD_STATUSES = ["new", "contacted", "sold", "rejected", "duplicate"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** What the repository is asked to write. Derived, never taken from the wire. */
export interface CreateLead {
  dedupeKey: string;
  submittedAt: Date;
  zip: string;
  stateSelected: string;
  stateFromZip: string | null;
  vehicleYear: number;
  currentlyInsured: boolean;
  firstName: string;
  lastName: string;
  age: number;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  emailNormalised: string;
  rawPayload: unknown;
  consent: {
    text: string;
    version: string;
    consentedAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
    landingPageUrl: string | null;
    trustedFormCertUrl: string | null;
  };
  attribution: {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmTerm: string | null;
    utmContent: string | null;
    gclid: string | null;
    fbclid: string | null;
    referrer: string | null;
    sessionId: string;
    formStartedAt: Date | null;
    formCompletedAt: Date;
  };
}

/**
 * Maps a validated webhook body onto the insert shape.
 *
 * Every derived value is computed here, in one place: the string answers become
 * numbers, the phone and email gain their normalised forms, and the dedupe key
 * is calculated. `rawPayload` is the *original* body, not the parsed result --
 * the parsed result has already dropped unknown keys and truncated long ones.
 */
export function toCreateLead(payload: LeadWebhook, rawPayload: unknown): CreateLead {
  const { answers, consent, audit, attribution } = payload;

  return {
    dedupeKey: deriveDedupeKey(audit.sessionId, audit.formCompletedAt),
    submittedAt: payload.receivedAt,

    zip: answers.zip,
    stateSelected: answers.state,
    stateFromZip: payload.state,
    vehicleYear: Number(answers.vehicleYear),
    currentlyInsured: answers.currentlyInsured === "yes",
    firstName: answers.firstName,
    lastName: answers.lastName,
    age: Number(answers.age),
    phoneRaw: answers.phone,
    phoneE164: normalisePhone(answers.phone),
    email: answers.email,
    emailNormalised: normaliseEmail(answers.email),
    rawPayload,

    consent: {
      text: consent.text,
      version: consent.version,
      consentedAt: consent.timestamp,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
      landingPageUrl: audit.landingPageUrl,
      trustedFormCertUrl: audit.trustedFormCertUrl,
    },

    attribution: {
      utmSource: attribution.utm_source,
      utmMedium: attribution.utm_medium,
      utmCampaign: attribution.utm_campaign,
      utmTerm: attribution.utm_term,
      utmContent: attribution.utm_content,
      gclid: attribution.gclid,
      fbclid: attribution.fbclid,
      referrer: audit.referrer,
      sessionId: audit.sessionId,
      formStartedAt: audit.formStartedAt,
      formCompletedAt: audit.formCompletedAt,
    },
  };
}

/* --------------------------------------------------------------- read models */

/** The persisted lead, in application casing. */
export interface Lead {
  id: number;
  submittedAt: Date;
  zip: string;
  stateSelected: string;
  stateFromZip: string | null;
  vehicleYear: number;
  currentlyInsured: boolean;
  firstName: string;
  lastName: string;
  age: number;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  status: LeadStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * True when an earlier lead shares this one's phone or email.
   *
   * Computed in the list and detail queries rather than stored: it is a
   * statement about the rest of the table, so a stored copy would be wrong the
   * moment a neighbouring row changed.
   */
  isRepeat: boolean;
}

export interface LeadConsent {
  text: string;
  version: string;
  consentedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  landingPageUrl: string | null;
  trustedFormCertUrl: string | null;
}

export interface LeadAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  gclid: string | null;
  fbclid: string | null;
  referrer: string | null;
  sessionId: string;
  formStartedAt: Date | null;
  formCompletedAt: Date;
}

/**
 * A row in the list, which carries just enough attribution to show where the
 * lead came from without the rest of the panel.
 *
 * A separate type from `Lead` rather than two optional fields on it: the status
 * endpoint genuinely does not return these, and an optional property that is
 * always present in one caller and never in another is a type that documents
 * nothing.
 */
export interface LeadListItem extends Lead {
  utmSource: string | null;
  utmCampaign: string | null;
}

/** A lead with everything attached. Only the detail view needs this much. */
export interface LeadDetail extends Lead {
  consent: LeadConsent;
  attribution: LeadAttribution;
  rawPayload: unknown;
  /** Ids of earlier leads from the same phone or email, newest first. */
  relatedLeadIds: number[];
}

/* ------------------------------------------------------------------ queries */

export const listLeadsSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),

  /** Two-letter state, matched against the ZIP-derived value. */
  state: stateCode.optional(),

  /* Coerced from the string "yes"/"no" the filter chips use, not from
     `z.coerce.boolean()`, which turns "false" into true. */
  currentlyInsured: z
    .enum(["yes", "no"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "yes")),

  utmSource: z.string().trim().max(200).optional(),
  utmCampaign: z.string().trim().max(200).optional(),

  /** Free text over name, email and phone. */
  q: z
    .string()
    .trim()
    .max(100, "Search terms are limited to 100 characters.")
    .optional()
    .transform((value) => (value ? value : undefined)),

  /** Inclusive date bounds on `created_at`, as YYYY-MM-DD. */
  from: nullableIsoDate.optional(),
  to: nullableIsoDate.optional(),

  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListLeadsQuery = z.output<typeof listLeadsSchema>;

export const updateLeadStatusSchema = z.object({ status: z.enum(LEAD_STATUSES) });

export const leadIdSchema = z.object({
  id: z.coerce.number().int().positive("Lead id must be a positive integer."),
});

/** Counters for the dashboard overview. Operations tool, not analytics. */
export interface LeadStats {
  total: number;
  today: number;
  last7Days: number;
  last30Days: number;
  byStatus: Record<LeadStatus, number>;
  /** Leads per state, busiest first. ZIP-derived; unknown ZIPs group as "??". */
  byState: { state: string; count: number }[];
  /** Leads per utm_source, busiest first. Null source groups as "direct". */
  bySource: { source: string; count: number }[];
}
