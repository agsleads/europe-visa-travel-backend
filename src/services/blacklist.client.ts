import { env } from "@/config/env";
import { AppError } from "@/lib/errors";

/**
 * Calls the Blacklist Alliance single-number lookup:
 *
 *   GET {BLACKLIST_ALLIANCE_API_URL}/lookup?key=<key>&phone=<10 digits>&resp=json[&ver=<v>]
 *
 * The key travels in the query string — that is the provider's only auth
 * scheme — so the URL is a secret. It is never logged and never put in an
 * error, and no `cause` is attached to the errors thrown here, since a fetch
 * error can carry the request it failed on.
 *
 * Refusals come back as `text/plain` with the reason repeated in an
 * `x-errmsg` header (e.g. 403 "API Key Not Found"); both are captured.
 *
 * Resolves with the provider's status and body for ANY HTTP answer, 2xx or
 * not; the route decides what to do with a refusal. Throws only when there is
 * no answer to report: not configured, timed out, or unreachable.
 */

export type BlacklistVersion = "v1" | "v2" | "v3" | "v5";

export interface BlacklistConfig {
  apiKey?: string;
  baseUrl: string;
  /** Omitted from the request when unset, leaving the provider's default. */
  version?: BlacklistVersion;
  timeoutMs: number;
}

export interface BlacklistResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON when the provider sent JSON, otherwise the raw text (or null if empty). */
  body: unknown;
  /** The provider's `x-errmsg` header, sent alongside refusals. */
  errorMessage: string | null;
}

function configFromEnv(): BlacklistConfig {
  return {
    apiKey: env.BLACKLIST_ALLIANCE_API_KEY,
    baseUrl: env.BLACKLIST_ALLIANCE_API_URL,
    version: env.BLACKLIST_ALLIANCE_VERSION,
    timeoutMs: env.BLACKLIST_ALLIANCE_TIMEOUT_MS,
  };
}

export function createBlacklistClient(
  config: BlacklistConfig = configFromEnv(),
  fetchImpl: typeof fetch = fetch,
) {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/lookup`;

  return {
    async lookup(phone: string): Promise<BlacklistResponse> {
      if (!config.apiKey) {
        throw new AppError(
          "Blacklist Alliance is not configured on this server (BLACKLIST_ALLIANCE_API_KEY is unset).",
          { status: 503, code: "blacklist_not_configured" },
        );
      }

      const url = new URL(endpoint);
      url.searchParams.set("key", config.apiKey);
      url.searchParams.set("phone", phone);
      url.searchParams.set("resp", "json");
      if (config.version) url.searchParams.set("ver", config.version);

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          // A hung upstream must not hold the caller's request open indefinitely.
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new AppError(
          timedOut ? "Blacklist Alliance did not respond in time." : "Blacklist Alliance could not be reached.",
          {
            status: timedOut ? 504 : 502,
            code: timedOut ? "blacklist_timeout" : "blacklist_unreachable",
          },
        );
      }

      const text = await response.text().catch(() => "");
      let body: unknown = text.trim() || null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON — keep the raw text so the caller still sees what was said.
      }

      return {
        ok: response.ok,
        status: response.status,
        body,
        errorMessage: response.headers.get("x-errmsg"),
      };
    },
  };
}

export type BlacklistClient = ReturnType<typeof createBlacklistClient>;
