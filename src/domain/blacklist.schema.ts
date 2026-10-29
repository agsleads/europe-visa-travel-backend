import { z } from "zod";

/**
 * Request body for POST /api/v1/blacklist/lookup.
 *
 * One US phone number. Blacklist Alliance takes the bare 10-digit form
 * (`2223334444`), so anything typed with punctuation, spaces or a leading
 * +1 / 1 is brought to that form here rather than bounced. Validated first so
 * an obviously broken number gets a clear 422 instead of spending a lookup.
 */
export const blacklistLookupSchema = z.object({
  phone: z
    .string()
    .trim()
    .transform((value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    })
    .pipe(
      z.string().regex(/^[2-9]\d{9}$/, "Expected a 10-digit US phone number, e.g. 2223334444."),
    ),
});

export type BlacklistLookupPayload = z.output<typeof blacklistLookupSchema>;
