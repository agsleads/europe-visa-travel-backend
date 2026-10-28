import { createHmac } from "node:crypto";

import { env } from "@/config/env";
import type { GraphForm, GraphLead } from "@/domain/facebook.schema";
import { AppError } from "@/lib/errors";

/**
 * A small client for the parts of the Meta Graph API that Lead Ads need.
 *
 * Plain `fetch`, like the Onyx client. Tokens travel in the Authorization
 * header, never in the URL, so they cannot end up in a proxy or error log.
 * Every call carries `appsecret_proof` (an HMAC of the token keyed by the app
 * secret), which Meta checks when the app requires it and which makes a leaked
 * token useless without the secret.
 */

export interface MetaConfig {
  appSecret?: string;
  graphVersion: string;
  timeoutMs: number;
  baseUrl?: string;
}

/** A refusal or failure from Graph. `retriable` is true for timeouts, network errors and 5xx. */
export class MetaGraphError extends AppError {
  readonly retriable: boolean;
  readonly metaCode: number | null;

  constructor(message: string, opts: { status: number; metaCode?: number | null; fbtraceId?: string | null; retriable: boolean }) {
    super(message, {
      status: 502,
      code: "meta_graph_error",
      details: { graphStatus: opts.status, metaCode: opts.metaCode ?? null, fbtraceId: opts.fbtraceId ?? null },
    });
    this.retriable = opts.retriable;
    this.metaCode = opts.metaCode ?? null;
  }
}

/** The lead fields `leads_retrieval` grants. Ad and campaign names would need `ads_read` as well. */
export const LEAD_FIELDS = "id,created_time,field_data,form_id,ad_id,adset_id,campaign_id,is_organic,platform";

interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

function configFromEnv(): MetaConfig {
  return {
    appSecret: env.META_APP_SECRET,
    graphVersion: env.META_GRAPH_API_VERSION,
    timeoutMs: env.META_GRAPH_TIMEOUT_MS,
    baseUrl: env.META_GRAPH_API_URL,
  };
}

export function createMetaClient(config: MetaConfig = configFromEnv(), fetchImpl: typeof fetch = fetch) {
  const base = `${(config.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "")}/${config.graphVersion}`;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    token: string,
    params: Record<string, string | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    if (config.appSecret) {
      url.searchParams.set("appsecret_proof", createHmac("sha256", config.appSecret).update(token).digest("hex"));
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new MetaGraphError(timedOut ? "Facebook did not respond in time." : "Facebook could not be reached.", {
        status: 0,
        retriable: true,
      });
    }

    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; reported below as an unexpected answer.
    }

    if (!response.ok) {
      const err = (body as { error?: { message?: string; code?: number; fbtrace_id?: string } } | null)?.error;
      throw new MetaGraphError(err?.message ? `Facebook: ${err.message}` : `Facebook answered ${response.status}.`, {
        status: response.status,
        metaCode: err?.code ?? null,
        fbtraceId: err?.fbtrace_id ?? null,
        // Code 1/2 are Meta's own transient errors; 4/17/32/613 are rate limits.
        retriable: response.status >= 500 || [1, 2, 4, 17, 32, 613].includes(err?.code ?? -1),
      });
    }
    return body as T;
  }

  /** Every page of a list, following cursors. `max` bounds a runaway list. */
  async function* pages<T>(path: string, token: string, params: Record<string, string | undefined>, max = 100) {
    let after: string | undefined;
    for (let i = 0; i < max; i++) {
      const page = await call<Paged<T>>("GET", path, token, { ...params, after });
      yield page.data ?? [];
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
      if (!after) return;
    }
  }

  return {
    getLead(leadId: string, token: string) {
      return call<GraphLead>("GET", leadId, token, { fields: LEAD_FIELDS });
    },

    getForm(formId: string, token: string) {
      return call<GraphForm>("GET", formId, token, { fields: "id,name,status,questions" });
    },

    getPage(pageId: string, token: string) {
      return call<{ id: string; name?: string }>("GET", pageId, token, { fields: "id,name" });
    },

    /** The page's lead forms, newest first. */
    forms(pageId: string, token: string) {
      return pages<GraphForm>(`${pageId}/leadgen_forms`, token, { fields: "id,name,status", limit: "100" });
    },

    /** A form's leads, optionally only those submitted after `since`. */
    leads(formId: string, token: string, since?: Date) {
      const filtering = since
        ? JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) - 1 }])
        : undefined;
      return pages<GraphLead>(`${formId}/leads`, token, { fields: LEAD_FIELDS, limit: "100", filtering }, 1_000);
    },

    /** The apps receiving this page's webhooks, with the fields each subscribed to. */
    async subscribedApps(pageId: string, token: string) {
      const page = await call<Paged<{ id: string; name?: string; subscribed_fields?: string[] }>>(
        "GET",
        `${pageId}/subscribed_apps`,
        token,
      );
      return page.data ?? [];
    },

    /** Subscribes this app to the page's `leadgen` webhooks. */
    async subscribeLeadgen(pageId: string, token: string) {
      const result = await call<{ success?: boolean }>("POST", `${pageId}/subscribed_apps`, token, {
        subscribed_fields: "leadgen",
      });
      return result?.success === true;
    },
  };
}

export type MetaClient = ReturnType<typeof createMetaClient>;
