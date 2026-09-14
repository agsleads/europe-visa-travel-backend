import { env } from "@/config/env";
import type { OnyxUtilizationPayload } from "@/domain/onyx.schema";
import { AppError } from "@/lib/errors";

/**
 * Calls the Onyx external utilization endpoint:
 *
 *   POST {ONYX_API_URL}/api/v1/external/organizations/{org}/sources/{source}/utilization
 *   Authorization: <ONYX_API_KEY>      (the key as-is, no "Bearer" prefix)
 *
 * Plain `fetch` rather than axios — Node 20 has it built in, so one POST does
 * not need a new dependency.
 *
 * Resolves with Onyx's status and body for ANY HTTP answer, 2xx or not; the
 * route decides what to do with a refusal. Throws only when there is no answer
 * to report: not configured, timed out, or unreachable.
 */

export interface OnyxConfig {
  apiKey?: string;
  baseUrl: string;
  organizationId: number;
  sourceId: number;
  timeoutMs: number;
}

export interface OnyxResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON when Onyx sent JSON, otherwise the raw text (or null if empty). */
  body: unknown;
}

function configFromEnv(): OnyxConfig {
  return {
    apiKey: env.ONYX_API_KEY,
    baseUrl: env.ONYX_API_URL,
    organizationId: env.ONYX_ORGANIZATION_ID,
    sourceId: env.ONYX_SOURCE_ID,
    timeoutMs: env.ONYX_TIMEOUT_MS,
  };
}

export function createOnyxClient(
  config: OnyxConfig = configFromEnv(),
  fetchImpl: typeof fetch = fetch,
) {
  const url =
    `${config.baseUrl.replace(/\/+$/, "")}/api/v1/external` +
    `/organizations/${config.organizationId}/sources/${config.sourceId}/utilization`;

  return {
    async postUtilization(payload: OnyxUtilizationPayload): Promise<OnyxResponse> {
      if (!config.apiKey) {
        throw new AppError("Onyx is not configured on this server (ONYX_API_KEY is unset).", {
          status: 503,
          code: "onyx_not_configured",
        });
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          // A hung upstream must not hold the caller's request open indefinitely.
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new AppError(
          timedOut ? "Onyx did not respond in time." : "Onyx could not be reached.",
          { status: timedOut ? 504 : 502, code: timedOut ? "onyx_timeout" : "onyx_unreachable" },
        );
      }

      const text = await response.text().catch(() => "");
      let body: unknown = text || null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON — keep the raw text so the caller still sees what Onyx said.
      }

      return { ok: response.ok, status: response.status, body };
    },
  };
}

export type OnyxClient = ReturnType<typeof createOnyxClient>;
