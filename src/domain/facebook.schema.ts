import { z } from "zod";

/**
 * Facebook Lead Ads: what Meta sends us, what we fetch, and what we keep.
 *
 * Meta's webhook only says "lead X was submitted on page Y". The lead itself
 * (name, email, every answer) is fetched from the Graph API with that page's
 * access token and the `leads_retrieval` permission.
 */

/** The `source` every Facebook lead is stored under. */
export const FACEBOOK_SOURCE = "facebook";

/** Graph ids are decimal strings; anything else is not an id we should put in a URL. */
const graphId = z.string().regex(/^\d{1,32}$/, "Expected a numeric Graph id.");

/**
 * The `leadgen` webhook payload. Only the fields we use are checked; Meta adds
 * fields over time and an unknown one must not make us reject a delivery.
 *
 *   { object: "page", entry: [{ id, time, changes: [{ field: "leadgen", value: {...} }] }] }
 */
export const leadgenWebhookSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z
                .object({
                  leadgen_id: z.coerce.string().optional(),
                  page_id: z.coerce.string().optional(),
                  form_id: z.coerce.string().optional(),
                })
                .passthrough()
                .optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type LeadgenWebhook = z.infer<typeof leadgenWebhookSchema>;

/** One `leadgen` change, reduced to what we need to fetch the lead. */
export interface LeadgenEvent {
  leadgenId: string;
  pageId: string;
  formId: string | null;
}

/** A lead as the Graph API returns it (`GET /{lead-id}` or `GET /{form-id}/leads`). */
export interface GraphLead {
  id: string;
  created_time: string;
  field_data?: { name: string; values?: string[] }[];
  form_id?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  is_organic?: boolean;
  /** "fb" or "ig". */
  platform?: string;
}

export interface GraphForm {
  id: string;
  name?: string;
  status?: string;
  questions?: { key: string; label?: string; type?: string }[];
}

/** One answer on the form, in the order the form asked. */
export interface LeadAnswer {
  key: string;
  label: string;
  value: string;
}

/**
 * Stored in `enquiries.lead_details`: everything Meta told us about the lead
 * beyond the core contact fields. Shown on the CRM's lead page.
 */
export interface FacebookLeadDetails {
  provider: "facebook";
  leadId: string;
  /** "facebook" or "instagram": where the ad was shown. */
  platform: string;
  pageId: string;
  pageName: string | null;
  formId: string | null;
  formName: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  isOrganic: boolean;
  submittedAt: string;
  answers: LeadAnswer[];
}

export const importLeadsSchema = z.object({
  /** One configured page; omitted means every configured page. */
  pageId: graphId.optional(),
  /** One form on that page; omitted means every form. */
  formId: graphId.optional(),
  /** Only leads submitted at or after this time. */
  since: z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === "" || !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date.")
    .transform((v) => (v ? new Date(v) : undefined)),
});

export type ImportLeadsRequest = z.output<typeof importLeadsSchema>;

export const pageIdParamSchema = z.object({ pageId: graphId });

export interface ImportState {
  status: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  /** Forms read so far. */
  forms: number;
  imported: number;
  /** Already in the CRM, so skipped. */
  duplicates: number;
  failed: number;
  error: string | null;
}

export interface FacebookPageStatus {
  id: string;
  name: string | null;
  /** Whether this app receives the page's `leadgen` webhooks. Null when it could not be checked. */
  subscribed: boolean | null;
  error: string | null;
}
