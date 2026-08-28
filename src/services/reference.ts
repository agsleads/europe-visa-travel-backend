import { randomInt } from "node:crypto";

/**
 * Human-quotable enquiry reference: EVC-XXXXXX.
 *
 * Crockford's base32 minus the ambiguous glyphs — no I, L, O or U — so a
 * reference read down the phone or copied off a screen cannot be transcribed
 * wrong in the ways references usually are. `randomInt` rather than
 * `Math.random`: the value is quoted as a weak identifier in email threads,
 * so it should not be guessable from a previously issued one.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 6;

export function generateReference(prefix = "EVC"): string {
  let body = "";
  for (let i = 0; i < LENGTH; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${body}`;
}
