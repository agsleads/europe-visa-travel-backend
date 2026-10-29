import { z } from "zod";

/**
 * Brings a typed phone number to E.164, which CallGrid's error guide asks for
 * (`+15551234567`). A leading + is trusted as international; otherwise 10
 * digits, or 11 starting with 1, is read as US. Anything else is passed on
 * unchanged so the regex below can say what is wrong with what was typed.
 */
function toE164(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (value.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value;
}

const callerId = z
  .string()
  .trim()
  .transform(toE164)
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Expected a phone number, e.g. +15551234567 or (555) 123-4567."));

/**
 * Buyer-defined extras ("age", "CampaignType", "PublisherId", tags...). The
 * names are the buyer's to choose, so they are not listed; only their shape is
 * bounded, so this route cannot be used to forward arbitrary blobs.
 */
const customValue = z.union([z.string().trim().max(200), z.number().finite(), z.boolean()]);

const customFields = (value: Record<string, unknown>) => Object.keys(value).length <= 30;

/**
 * Request body for POST /api/v1/callgrid/bid.
 *
 * Field names are CallGrid's own, so the body a caller sends here is exactly
 * the body forwarded to CallGrid. Only the caller ID is required.
 */
export const callGridBidSchema = z
  .object({
    CallerId: callerId,

    InboundStateCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "Expected a two-letter state code, e.g. CO.")
      .optional(),

    InboundZipCode: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "Expected a five-digit ZIP code, e.g. 80301.")
      .optional(),

    /** Ask for a dynamic phone number instead of a SIP address. */
    pstn: z.boolean().optional(),
  })
  .catchall(customValue)
  .refine(customFields, "Send at most 30 fields.");

export type CallGridBidPayload = z.output<typeof callGridBidSchema>;

/**
 * Request body for POST /api/v1/callgrid/bid/:bidId/confirm. CallGrid takes
 * the same extras as the bid; CallerId is only needed if the bid lacked one.
 */
export const callGridConfirmSchema = z
  .object({ CallerId: callerId.optional() })
  .catchall(customValue)
  .refine(customFields, "Send at most 30 fields.");

export type CallGridConfirmPayload = z.output<typeof callGridConfirmSchema>;

/** CallGrid bid ids look like `cm42x8hbv109ixtz64jdqmzof`. */
export const callGridBidParamsSchema = z.object({
  bidId: z.string().regex(/^[A-Za-z0-9]{10,64}$/, "Expected a CallGrid bid id."),
});
