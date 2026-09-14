import { z } from "zod";

/**
 * Request body for POST /api/v1/onyx/utilization.
 *
 * Field names match Onyx's own, so the body a caller sends here is exactly the
 * body forwarded to Onyx. Validated first so an obviously broken request is
 * answered with a clear 422 here, instead of being sent on and bounced by Onyx.
 */
export const onyxUtilizationSchema = z.object({
  lead_phone_number: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Expected an E.164 phone number, e.g. +14155550199."),

  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Expected a two-letter state code, e.g. CA."),

  zip_code: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Expected a five-digit ZIP code, e.g. 94105."),

  external_id: z.string().trim().min(1, "external_id is required.").max(100),

  first_name: z.string().trim().min(1, "first_name is required.").max(100),
  last_name: z.string().trim().min(1, "last_name is required.").max(100),

  date_of_birth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format.")
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That date does not exist.")
    .optional(),

  email: z.string().trim().max(254).email("Expected a valid email address."),

  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
});

export type OnyxUtilizationPayload = z.output<typeof onyxUtilizationSchema>;
