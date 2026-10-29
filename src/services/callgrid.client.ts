import { env } from "@/config/env";
import { AppError } from "@/lib/errors";

/**
 * Calls the CallGrid Bid API:
 *
 *   POST {CALLGRID_API_URL}/api/bid/{CALLGRID_GRID_ID}            ask for a bid
 *   POST {CALLGRID_API_URL}/api/bid/confirmation/{bidId}          confirm one
 *
 * CallGrid has no API key: the Grid ID in the path is the whole credential,
 * so it is treated like one — never logged, never put in an error.
 *
 * A rejected bid is still HTTP 200, with a four-digit `code` (4001-4013) in
 * the body; only `code` 1000 is a bid. Rate limiting is HTTP 429 with code
 * 5001.
 *
 * Resolves with CallGrid's status and body for ANY HTTP answer, 2xx or not;
 * the route decides what to do with it. Throws only when there is no answer
 * to report: not configured, timed out, or unreachable.
 */

export interface CallGridConfig {
  gridId?: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface CallGridResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON when CallGrid sent JSON, otherwise the raw text (or null if empty). */
  body: unknown;
}

function configFromEnv(): CallGridConfig {
  return {
    gridId: env.CALLGRID_GRID_ID,
    baseUrl: env.CALLGRID_API_URL,
    timeoutMs: env.CALLGRID_TIMEOUT_MS,
  };
}

export function createCallGridClient(
  config: CallGridConfig = configFromEnv(),
  fetchImpl: typeof fetch = fetch,
) {
  const base = `${config.baseUrl.replace(/\/+$/, "")}/api/bid`;

  async function post(url: string, payload: Record<string, unknown>): Promise<CallGridResponse> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        // A hung upstream must not hold the caller's request open indefinitely.
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new AppError(timedOut ? "CallGrid did not respond in time." : "CallGrid could not be reached.", {
        status: timedOut ? 504 : 502,
        code: timedOut ? "callgrid_timeout" : "callgrid_unreachable",
      });
    }

    const text = await response.text().catch(() => "");
    let body: unknown = text.trim() || null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON — keep the raw text so the caller still sees what was said.
    }

    return { ok: response.ok, status: response.status, body };
  }

  function requireGrid(): string {
    if (!config.gridId) {
      throw new AppError("CallGrid is not configured on this server (CALLGRID_GRID_ID is unset).", {
        status: 503,
        code: "callgrid_not_configured",
      });
    }
    return config.gridId;
  }

  return {
    bid(payload: Record<string, unknown>): Promise<CallGridResponse> {
      return post(`${base}/${encodeURIComponent(requireGrid())}`, payload);
    },

    /* The confirmation URL carries no Grid ID, but confirming is still gated
       on one being configured: a server not set up for CallGrid should not
       talk to it at all. */
    confirm(bidId: string, payload: Record<string, unknown>): Promise<CallGridResponse> {
      requireGrid();
      return post(`${base}/confirmation/${encodeURIComponent(bidId)}`, payload);
    },
  };
}

export type CallGridClient = ReturnType<typeof createCallGridClient>;
