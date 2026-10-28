import { env } from "@/config/env";
import type { Enquiry, ExternalEnquiry } from "@/domain/enquiry.schema";
import {
  FACEBOOK_SOURCE,
  type FacebookLeadDetails,
  type FacebookPageStatus,
  type GraphForm,
  type GraphLead,
  type ImportLeadsRequest,
  type ImportState,
  type LeadAnswer,
  type LeadgenEvent,
  type LeadgenWebhook,
} from "@/domain/facebook.schema";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { enquiryRepository, UNIQUE_VIOLATION, type EnquiryRepository } from "@/repositories/enquiry.repository";
import { createMetaClient, MetaGraphError, type MetaClient } from "@/services/meta.client";
import { generateReference } from "@/services/reference";

/**
 * Facebook Lead Ads -> enquiries.
 *
 * Two ways in, one way of storing:
 *   - the `leadgen` webhook, for each lead as it is submitted;
 *   - an import, for leads submitted before the webhook was connected or while
 *     it was down.
 * Both go through `store`, which is idempotent on Meta's lead id, so a lead
 * that arrives by both routes, or twice by one, is stored once.
 */

/** Shown wherever a form did not ask for the field. */
export const NOT_SPECIFIED = "Not specified";

const STANDARD_LABELS: Record<string, string> = {
  full_name: "Full name",
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  work_email: "Work email",
  phone_number: "Phone number",
  work_phone_number: "Work phone number",
  city: "City",
  country: "Country",
  state: "State",
  zip_code: "Zip code",
  post_code: "Post code",
  date_of_birth: "Date of birth",
  job_title: "Job title",
  company_name: "Company name",
};

/** "visa_type" -> "Visa type", for a question with no label. */
function labelFor(key: string) {
  const text = key.replace(/[_?]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : key;
}

/**
 * Multiple-choice answers arrive as the option's key ("france",
 * "united_kingdom"); free-text answers arrive as typed. Only a bare lowercase
 * key is reworded, so a typed sentence or an email is left alone.
 */
function readable(value: string) {
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(value)) return value;
  return value
    .split("_")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

const clip = (value: string, max: number) => value.replace(/[\r\n\t\f\v\0]+/g, " ").trim().slice(0, max);

/**
 * Maps a Graph lead onto enquiry fields. Pure, so every rule is tested
 * without Graph or a database.
 *
 * Standard questions map by key. Custom questions are matched by key words,
 * because each advertiser names them differently: anything with "destination"
 * or "country" (other than the lead's own country) is the destination, "visa"
 * the visa type, "month"/"when"/"date" the travel month. Every answer,
 * matched or not, is kept in `leadDetails.answers` and listed in the message,
 * so nothing the lead told us is lost.
 */
export function mapFacebookLead(
  lead: GraphLead,
  context: { pageId: string; pageName?: string | null; form?: GraphForm | null },
): ExternalEnquiry {
  const questionLabels = new Map((context.form?.questions ?? []).map((q) => [q.key, q.label ?? ""]));
  const answers: LeadAnswer[] = (lead.field_data ?? [])
    .map((field) => ({
      key: field.name,
      label: questionLabels.get(field.name) || STANDARD_LABELS[field.name] || labelFor(field.name),
      value: (field.values ?? []).map(readable).join(", ").trim(),
    }))
    .filter((a) => a.value !== "");

  const used = new Set<string>();
  const take = (predicate: (key: string) => boolean) => {
    const answer = answers.find((a) => !used.has(a.key) && predicate(a.key.toLowerCase()));
    if (answer) used.add(answer.key);
    return answer?.value;
  };

  const fullName = take((k) => k === "full_name");
  const first = take((k) => k === "first_name");
  const last = take((k) => k === "last_name");
  const emailAnswer = take((k) => k === "email" || k === "work_email");
  const phone = take((k) => k === "phone_number" || k === "phone" || k === "work_phone_number");
  const destination = take((k) => k === "destination" || /destination|where.*(go|travel|visit)|country.*(visit|travel|apply)/.test(k));
  const visaType = take((k) => k === "visa_type" || /visa/.test(k));
  // A date question, not merely one mentioning travel: "how_many_travellers?" is a count.
  const travelMonth = take(
    (k) => k === "travel_month" || k === "travel_date" || (/month|when|date/.test(k) && !/birth/.test(k)),
  );

  const email = emailAnswer && /^[^\s@]+@[^\s@]+$/.test(emailAnswer) ? clip(emailAnswer.toLowerCase(), 254) : null;
  const name = clip(fullName || [first, last].filter(Boolean).join(" ") || email || phone || "Facebook lead", 100);

  const formName = context.form?.name ?? null;
  const rest = answers.filter((a) => !used.has(a.key));
  const message = clip(
    [
      `Submitted through Facebook Lead Ads${formName ? ` (form "${formName}")` : ""}.`,
      ...rest.map((a) => `${a.label}: ${a.value}`),
    ].join(" | "),
    2000,
  );

  const platform = lead.platform === "ig" ? "instagram" : "facebook";
  const details: FacebookLeadDetails = {
    provider: "facebook",
    leadId: lead.id,
    platform,
    pageId: context.pageId,
    pageName: context.pageName ?? null,
    formId: lead.form_id ?? context.form?.id ?? null,
    formName,
    adId: lead.ad_id ?? null,
    adsetId: lead.adset_id ?? null,
    campaignId: lead.campaign_id ?? null,
    isOrganic: lead.is_organic === true,
    submittedAt: new Date(lead.created_time).toISOString(),
    answers,
  };

  const receivedAt = new Date(lead.created_time);
  return {
    name,
    email,
    phone: phone ? clip(phone, 30) : null,
    destination: clip(destination ?? NOT_SPECIFIED, 100),
    visaType: clip(visaType ?? NOT_SPECIFIED, 100),
    travelMonth: clip(travelMonth ?? NOT_SPECIFIED, 40),
    message,
    source: FACEBOOK_SOURCE,
    externalId: lead.id,
    leadDetails: details as unknown as Record<string, unknown>,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    activityDescription: `Lead received from ${platform === "instagram" ? "Instagram" : "Facebook"} Lead Ads${
      formName ? ` (form "${formName}")` : ""
    }`,
  };
}

/** The `leadgen` changes in a webhook delivery. Other objects and fields are ignored. */
export function leadgenEvents(payload: LeadgenWebhook): LeadgenEvent[] {
  if (payload.object !== "page") return [];
  return payload.entry.flatMap((entry) =>
    entry.changes
      .filter((change) => change.field === "leadgen" && change.value?.leadgen_id)
      .map((change) => ({
        leadgenId: change.value!.leadgen_id!,
        pageId: change.value!.page_id ?? entry.id ?? "",
        formId: change.value!.form_id ?? null,
      })),
  );
}

const IDLE: ImportState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  forms: 0,
  imported: 0,
  duplicates: 0,
  failed: 0,
  error: null,
};

export interface FacebookLeadServiceDeps {
  repository?: EnquiryRepository;
  graph?: MetaClient;
  /** Page id -> page access token. */
  pageTokens?: Map<string, string>;
  appId?: string;
}

export function createFacebookLeadService({
  repository = enquiryRepository,
  graph = createMetaClient(),
  pageTokens = env.META_PAGE_ACCESS_TOKENS,
  appId = env.META_APP_ID,
}: FacebookLeadServiceDeps = {}) {
  /** Forms rarely change; cached so a burst of leads does not refetch the same form. */
  const formCache = new Map<string, { form: GraphForm | null; at: number }>();
  const pageNames = new Map<string, string | null>();
  const FORM_TTL_MS = 60 * 60_000;
  let importState: ImportState = { ...IDLE };

  function tokenFor(pageId: string): string {
    const token = pageTokens.get(pageId);
    if (!token) {
      throw new AppError(`Facebook page ${pageId} is not configured on this server.`, {
        status: 422,
        code: "meta_page_not_configured",
      });
    }
    return token;
  }

  /** Best-effort: a form or page we cannot read only costs us its name and labels. */
  async function formFor(formId: string | null | undefined, token: string): Promise<GraphForm | null> {
    if (!formId) return null;
    const cached = formCache.get(formId);
    if (cached && Date.now() - cached.at < FORM_TTL_MS) return cached.form;
    const form = await graph.getForm(formId, token).catch((error: unknown) => {
      logger.warn({ formId, err: (error as Error).message }, "Could not read Facebook lead form");
      return null;
    });
    formCache.set(formId, { form, at: Date.now() });
    return form;
  }

  async function pageNameFor(pageId: string, token: string): Promise<string | null> {
    if (pageNames.has(pageId)) return pageNames.get(pageId)!;
    const name = await graph
      .getPage(pageId, token)
      .then((p) => p.name ?? null)
      .catch(() => null);
    pageNames.set(pageId, name);
    return name;
  }

  /** Stores one lead, retrying a reference collision. Null when it was already stored. */
  async function store(lead: GraphLead, pageId: string, token: string): Promise<Enquiry | null> {
    const [form, pageName] = await Promise.all([formFor(lead.form_id, token), pageNameFor(pageId, token)]);
    const input = mapFacebookLead(lead, { pageId, pageName, form });
    for (let attempt = 1; ; attempt++) {
      try {
        return await repository.createExternal({ ...input, reference: generateReference() });
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION && attempt < 3) continue;
        throw error;
      }
    }
  }

  const service = {
    /**
     * Fetches and stores one lead from a webhook event. Already-stored leads
     * are skipped before Graph is called, so a redelivery costs one query.
     */
    async ingest(event: LeadgenEvent): Promise<"created" | "duplicate"> {
      const known = await repository.existingExternalIds(FACEBOOK_SOURCE, [event.leadgenId]);
      if (known.has(event.leadgenId)) return "duplicate";

      const token = tokenFor(event.pageId);
      const lead = await graph.getLead(event.leadgenId, token);
      const stored = await store({ ...lead, form_id: lead.form_id ?? event.formId ?? undefined }, event.pageId, token);
      if (!stored) return "duplicate";
      // Identifiers only: the lead itself is personal data.
      logger.info(
        { enquiryId: stored.id, reference: stored.reference, leadgenId: event.leadgenId, pageId: event.pageId },
        "Facebook lead stored",
      );
      return "created";
    },

    /**
     * Every `leadgen` change in a delivery, a few at a time so a large batch
     * still answers Meta promptly. Resolves with the counts; rejects if any
     * lead failed, so the route can answer 500 and Meta redelivers. Leads that
     * did succeed are skipped as duplicates on the redelivery.
     */
    async handleWebhook(payload: LeadgenWebhook) {
      const events = leadgenEvents(payload);
      const result = { received: events.length, created: 0, duplicates: 0, failed: 0 };
      const CONCURRENCY = 4;
      for (let i = 0; i < events.length; i += CONCURRENCY) {
        await Promise.all(
          events.slice(i, i + CONCURRENCY).map(async (event) => {
            try {
              const outcome = await service.ingest(event);
              if (outcome === "created") result.created++;
              else result.duplicates++;
            } catch (error) {
              result.failed++;
              logger.error(
                {
                  leadgenId: event.leadgenId,
                  pageId: event.pageId,
                  code: (error as AppError).code,
                  err: (error as Error).message,
                },
                "Could not store Facebook lead",
              );
            }
          }),
        );
      }
      if (result.failed > 0) {
        throw new AppError(`${result.failed} of ${result.received} Facebook leads could not be stored.`, {
          status: 500,
          code: "meta_ingest_failed",
          details: result,
        });
      }
      return result;
    },

    importState(): ImportState {
      return { ...importState };
    },

    /**
     * Starts importing existing leads in the background and returns at once:
     * a page with years of leads takes far longer than any HTTP timeout.
     * Progress is read from `importState`. One import at a time.
     */
    startImport(request: ImportLeadsRequest): ImportState {
      if (importState.status === "running") throw new ConflictError("An import is already running.");
      const pageIds = request.pageId ? [request.pageId] : [...pageTokens.keys()];
      if (pageIds.length === 0) {
        throw new AppError("No Facebook pages are configured (META_PAGE_ACCESS_TOKENS).", {
          status: 422,
          code: "meta_page_not_configured",
        });
      }
      for (const pageId of pageIds) tokenFor(pageId);

      importState = { ...IDLE, status: "running", startedAt: new Date().toISOString() };
      void service
        .runImport(pageIds, request)
        .then(() => {
          importState = { ...importState, status: "succeeded", finishedAt: new Date().toISOString() };
          logger.info({ ...importState }, "Facebook lead import finished");
        })
        .catch((error: unknown) => {
          importState = {
            ...importState,
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "The import failed.",
          };
          logger.error({ ...importState }, "Facebook lead import failed");
        });
      return service.importState();
    },

    /** The import itself. Exposed for tests, which await it directly. */
    async runImport(pageIds: string[], { formId, since }: ImportLeadsRequest) {
      for (const pageId of pageIds) {
        const token = tokenFor(pageId);
        const formIds: string[] = [];
        if (formId) formIds.push(formId);
        else for await (const forms of graph.forms(pageId, token)) formIds.push(...forms.map((f) => f.id));

        for (const id of formIds) {
          importState.forms++;
          for await (const batch of graph.leads(id, token, since)) {
            const known = await repository.existingExternalIds(
              FACEBOOK_SOURCE,
              batch.map((lead) => lead.id),
            );
            for (const lead of batch) {
              if (known.has(lead.id)) {
                importState.duplicates++;
                continue;
              }
              try {
                const stored = await store({ ...lead, form_id: lead.form_id ?? id }, pageId, token);
                if (stored) importState.imported++;
                else importState.duplicates++;
              } catch (error) {
                importState.failed++;
                logger.error({ leadgenId: lead.id, err: (error as Error).message }, "Could not import Facebook lead");
              }
            }
          }
        }
      }
    },

    /** Each configured page: its name, and whether this app gets its `leadgen` webhooks. Never the token. */
    async pages(): Promise<FacebookPageStatus[]> {
      return Promise.all(
        [...pageTokens.entries()].map(async ([id, token]) => {
          try {
            const [page, apps] = await Promise.all([graph.getPage(id, token), graph.subscribedApps(id, token)]);
            return {
              id,
              name: page.name ?? null,
              subscribed: apps.some(
                (app) => (!appId || app.id === appId) && (app.subscribed_fields ?? []).includes("leadgen"),
              ),
              error: null,
            };
          } catch (error) {
            return { id, name: null, subscribed: null, error: (error as Error).message };
          }
        }),
      );
    },

    /** Subscribes this app to a configured page's `leadgen` webhooks. */
    async subscribe(pageId: string): Promise<FacebookPageStatus> {
      if (!pageTokens.has(pageId)) throw new NotFoundError(`Facebook page ${pageId} is not configured on this server.`);
      const ok = await graph.subscribeLeadgen(pageId, tokenFor(pageId));
      if (!ok) throw new MetaGraphError("Facebook did not confirm the subscription.", { status: 200, retriable: false });
      logger.info({ pageId }, "Subscribed to Facebook leadgen webhooks");
      return (await service.pages()).find((p) => p.id === pageId)!;
    },
  };

  return service;
}

export type FacebookLeadService = ReturnType<typeof createFacebookLeadService>;
