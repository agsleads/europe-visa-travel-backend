import { createHash } from "node:crypto";
import { z } from "zod";

import { cappedText, isoDate, normaliseEmail, normalisePhone } from "@/domain/shared";

/**
 * The contract for a Final Expense Coverage lead (finalexpensecoverage.us).
 *
 * The site validates every answer in the browser and again in its own server
 * route before it posts here. This re-validates all of it anyway: this API is a
 * separate trust boundary, and it must be correct when called by a replayed
 * request, a second producer, or curl.
 *
 * Two rules shape the schema, and they pull in opposite directions -- the same
 * two that shape the Road Cover schema:
 *
 *   - The *answers* are rejected when invalid. They are the lead; a lead with a
 *     malformed phone number is not worth having.
 *   - The *audit* strings are truncated when too long, never rejected. A long
 *     user agent is not a reason to lose a real lead. The untruncated value
 *     survives verbatim in `raw_payload` regardless.
 *
 * The consent text is the exception to both: it is evidence, so it is stored
 * exactly as sent, and an implausibly long one is rejected outright rather than
 * silently shortened. A truncated consent record is worse than none.
 */

/* ------------------------------------------------------------------ helpers */

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Parses `YYYY-MM-DD` into its parts, or null if it is not a real date.
 *
 * Round-tripped through `Date.UTC` because `2026-02-31` matches the pattern and
 * is not a date; the constructor quietly rolls it into March, so the parts have
 * to be read back and compared.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/**
 * Whole years between a date of birth and a reference instant.
 *
 * Both sides are read in UTC, so the answer does not depend on the timezone the
 * server happens to run in. Negative for a date of birth in the future.
 */
export function ageOn(dateOfBirth: CalendarDate, reference: Date): number {
  let age = reference.getUTCFullYear() - dateOfBirth.year;

  const beforeBirthday =
    reference.getUTCMonth() + 1 < dateOfBirth.month ||
    (reference.getUTCMonth() + 1 === dateOfBirth.month && reference.getUTCDate() < dateOfBirth.day);

  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Plausibility bounds, wider than the site's own 50-85 product range.
 *
 * The site decides who it sells to; this only refuses what cannot be a person.
 * Tightening it to the current product would make a future marketing decision
 * (a 45+ plan) a coordinated release with this service, and every lead in the
 * gap a 422.
 */
export const MIN_AGE = 18;
export const MAX_AGE = 110;

/** Whole dollars the person asked to be quoted for. */
export const MIN_COVERAGE = 1_000;
export const MAX_COVERAGE = 1_000_000;

/* ------------------------------------------------------------------ answers */

/**
 * `coverageAmount` normally arrives as a number, but a form that posts strings
 * is one refactor away, and a digit string is unambiguous. Anything else -- an
 * empty string, "12,000", a float -- is rejected rather than coerced: `Number("")`
 * is `0` and `Number(null)` is `0`, which is how a missing answer becomes a
 * plausible-looking one.
 */
const coverageAmount = z
  .union([z.number(), z.string().trim().regex(/^\d{1,8}$/, "Expected a whole dollar amount.")])
  .transform((value) => (typeof value === "number" ? value : Number(value)))
  .pipe(
    z
      .number()
      .int("Expected a whole dollar amount.")
      .min(MIN_COVERAGE, `Coverage starts at $${MIN_COVERAGE.toLocaleString("en-US")}.`)
      .max(MAX_COVERAGE, `Coverage is capped at $${MAX_COVERAGE.toLocaleString("en-US")}.`),
  );

export const finalExpenseAnswersSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(50),
  lastName: z.string().trim().min(1, "Last name is required.").max(50),

  /* Arrives pre-masked as "(555) 555-5555". Validated on the ten digits inside
     it rather than on the mask, so a differently formatted but valid number is
     still accepted. */
  phone: z
    .string()
    .trim()
    .min(1, "A phone number is required.")
    .max(30)
    .refine((value) => normalisePhone(value) !== null, "Expected a ten-digit US phone number."),

  email: z.string().trim().toLowerCase().min(1).max(254).email("Expected a valid email address."),

  /* ZIP+4 is accepted although the site's input only takes five digits: it is a
     valid ZIP, and refusing it would cost a lead over formatting. */
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Expected a five-digit ZIP code."),

  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date of birth as YYYY-MM-DD.")
    .refine((value) => parseCalendarDate(value) !== null, "Expected a real calendar date."),

  coverageAmount,
});

export type FinalExpenseAnswers = z.infer<typeof finalExpenseAnswersSchema>;

/* ----------------------------------------------------------------- envelope */

export const finalExpenseWebhookSchema = z
  .object({
    /* Generated in the visitor's browser and re-sent on a retry. Required: it is
       the whole dedupe key. A submission without one cannot be deduplicated, and
       defaulting it would make every such submission collide with every other. */
    submissionId: z
      .string()
      .trim()
      .min(8, "A submission id is required.")
      .max(100, "The submission id is too long."),

    /* The producer's own receipt time. */
    receivedAt: isoDate,

    /* Which site and form sent it, e.g. "finalexpensecoverage.us/#quote" or
       "finalexpensecoverage.us/contact". Shown to operators as-is. */
    source: z.string().trim().min(1, "A source is required.").max(100),

    answers: finalExpenseAnswersSchema,

    consent: z.object({
      /* Capped far above the ~700 characters the current wording runs to, and
         NOT truncated with `cappedText` -- see the note at the top of the file. */
      text: z.string().min(1, "The consent text is required.").max(20_000),
      version: z.string().trim().min(1, "The consent version is required.").max(80),
      timestamp: isoDate,
    }),

    /* Optional as a whole: the visitor's IP and browser are context, and a
       producer that could not read them should still be able to post the lead. */
    audit: z
      .object({
        ipAddress: cappedText(45),
        userAgent: cappedText(1_000),
      })
      .default({}),
  })
  /* Age depends on two fields at once -- the birthday and when the form was
     submitted -- so it cannot be checked on `dateOfBirth` alone. It is measured
     at the producer's receipt time rather than at "now": a replayed request an
     hour after a birthday must not change the age the person had when they
     asked. */
  .superRefine((value, ctx) => {
    /* Zod runs this even when another field has already failed, so neither
       input can be assumed valid. The date of birth is re-parsed below. For
       `receivedAt`, the Zod release pinned here aborts the whole parse before
       this runs, so the guard is defensive: some Zod 3 releases instead pass a
       failed transform's raw string through, and reading that as a Date would
       throw and turn a 422 into a 500. Each failure is already reported on its
       own field, so returning early loses nothing. */
    if (!(value.receivedAt instanceof Date) || Number.isNaN(value.receivedAt.getTime())) return;
    const dob = parseCalendarDate(value.answers.dateOfBirth);
    if (!dob) return;

    const age = ageOn(dob, value.receivedAt);
    if (age < MIN_AGE || age > MAX_AGE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answers", "dateOfBirth"],
        message: `Expected an age between ${MIN_AGE} and ${MAX_AGE}.`,
      });
    }
  });

/* Unknown keys are stripped from the parsed value but survive in `raw_payload`,
   which is stored unmodified. That is what makes the site gaining a new answer a
   forward-compatible change here rather than a 422 and a lost lead. */
export type FinalExpenseWebhook = z.output<typeof finalExpenseWebhookSchema>;
export type FinalExpenseWebhookInput = z.input<typeof finalExpenseWebhookSchema>;

/* -------------------------------------------------------------- persistence */

/** What the repository is asked to write. Derived, never taken from the wire. */
export interface CreateFinalExpenseLead {
  dedupeKey: string;
  submittedAt: Date;
  source: string;
  firstName: string;
  lastName: string;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  emailNormalised: string;
  zip: string;
  /** `YYYY-MM-DD`. Kept as a string end to end -- see the note on the column. */
  dateOfBirth: string;
  age: number;
  coverageAmount: number;
  rawPayload: unknown;
  consent: {
    text: string;
    version: string;
    consentedAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  };
}

/**
 * The idempotency key: sha256 of the source and the submission id.
 *
 * The source is part of it so two sites can never collide on an id, even by
 * accident -- the unique index is table-wide, and one site's UUID being another
 * site's "already recorded" would silently drop a real lead.
 */
export function deriveDedupeKey(source: string, submissionId: string): string {
  return createHash("sha256").update(`${source}\n${submissionId}`).digest("hex");
}

/**
 * Maps a validated webhook body onto the insert shape.
 *
 * Every derived value is computed here, in one place: the age, the normalised
 * phone and email, and the dedupe key. `rawPayload` is the *original* body, not
 * the parsed result -- the parsed result has already dropped unknown keys and
 * truncated long ones.
 */
export function toCreateFinalExpenseLead(
  payload: FinalExpenseWebhook,
  rawPayload: unknown,
): CreateFinalExpenseLead {
  const { answers, consent, audit } = payload;

  // Non-null: the envelope's superRefine has already rejected an invalid date.
  const dob = parseCalendarDate(answers.dateOfBirth)!;

  return {
    dedupeKey: deriveDedupeKey(payload.source, payload.submissionId),
    submittedAt: payload.receivedAt,
    source: payload.source,

    firstName: answers.firstName,
    lastName: answers.lastName,
    phoneRaw: answers.phone,
    phoneE164: normalisePhone(answers.phone),
    email: answers.email,
    emailNormalised: normaliseEmail(answers.email),
    zip: answers.zip,
    dateOfBirth: answers.dateOfBirth,
    age: ageOn(dob, payload.receivedAt),
    coverageAmount: answers.coverageAmount,
    rawPayload,

    consent: {
      text: consent.text,
      version: consent.version,
      consentedAt: consent.timestamp,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    },
  };
}

/* --------------------------------------------------------------- read models */

/**
 * A lead as the list shows it.
 *
 * Deliberately has no date of birth: it is the most sensitive field on the row,
 * a list is mostly scanned rather than read, and the age is what an operator
 * triages on. The detail view adds it.
 */
export interface FinalExpenseLead {
  id: number;
  submittedAt: Date;
  source: string;
  firstName: string;
  lastName: string;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  zip: string;
  age: number;
  coverageAmount: number;
  createdAt: Date;
  /**
   * True when an earlier lead shares this one's phone or email.
   *
   * Computed in the list and detail queries rather than stored: it is a
   * statement about the rest of the table, so a stored copy would be wrong the
   * moment a neighbouring row changed.
   */
  isRepeat: boolean;
}

export interface FinalExpenseLeadConsent {
  text: string;
  version: string;
  consentedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/** A lead with everything attached. Only the detail view needs this much. */
export interface FinalExpenseLeadDetail extends FinalExpenseLead {
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
  consent: FinalExpenseLeadConsent;
  rawPayload: unknown;
  /** Ids of earlier leads from the same phone or email, newest first. */
  relatedLeadIds: number[];
}

/* ------------------------------------------------------------------ queries */

export const listFinalExpenseLeadsSchema = z.object({
  /** Free text over name, email, phone and ZIP. */
  q: z
    .string()
    .trim()
    .max(100, "Search terms are limited to 100 characters.")
    .optional()
    .transform((value) => (value ? value : undefined)),

  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListFinalExpenseLeadsQuery = z.output<typeof listFinalExpenseLeadsSchema>;

export const finalExpenseLeadIdSchema = z.object({
  id: z.coerce.number().int().positive("Lead id must be a positive integer."),
});

/** Counters for the overview tiles. Operations, not analytics. */
export interface FinalExpenseLeadStats {
  total: number;
  /** Since midnight UTC. */
  today: number;
  last7Days: number;
  last30Days: number;
}
