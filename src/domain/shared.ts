import { z } from "zod";

/**
 * Validation and normalisation shared by every lead producer.
 *
 * Each producer (Road Cover, Final Expense Coverage, ...) has its own payload
 * and its own table, but the *rules* for "is this a phone number" and "how much
 * of an audit string is worth keeping" are not producer-specific. Keeping them
 * in one place means a fix to phone handling lands everywhere at once, and two
 * producers can never disagree about what a valid US number is.
 */

/* ------------------------------------------------------------------ zod */

/**
 * Bounded text that truncates rather than rejects, normalising "" to null.
 *
 * Applied only to fields where a wrong length is the producer's problem to fix
 * and not worth a lost lead over. `raw_payload` keeps the original.
 */
export const cappedText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed.slice(0, max);
    });

/**
 * An ISO timestamp, parsed to a Date.
 *
 * Deliberately looser than `z.string().datetime()`, which insists on a `Z` or
 * an explicit offset. `formStartedAt` comes out of the consumer's browser
 * storage, and refusing a timestamp this service only ever reads back as a
 * duration would, again, cost a real lead over an audit field.
 */
export const isoDate = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO 8601 timestamp.")
  .transform((value) => new Date(value));

export const nullableIsoDate = z
  .union([isoDate, z.null()])
  .nullish()
  .transform((value) => value ?? null);

/* ------------------------------------------------------------ normalising */

/**
 * A US phone number in E.164 (`+1XXXXXXXXXX`), or null if it is not one.
 *
 * Used for dialling and for "has this person submitted before?", which is why
 * it is stored alongside the raw string rather than replacing it: the raw form
 * is what the consumer typed, and the consent record refers to that.
 */
export function normalisePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  // A leading 1 is the country code, not an area code.
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  if (national.length !== 10) return null;
  // NANP area codes and exchange codes never begin with 0 or 1.
  if (/^[01]/.test(national) || /^[01]/.test(national.slice(3))) return null;

  return `+1${national}`;
}

/** Lower-cased and trimmed. The indexed form used to match repeat submissions. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}
