import rateLimit from "express-rate-limit";

import { env } from "@/config/env";

/**
 * Second line of defence. The Next.js Server Action limits by client IP
 * already; this limits the API itself, which protects against a caller that
 * bypasses the frontend entirely.
 *
 * KNOWN LIMIT — the default store is in-process, so on more than one instance
 * the effective limit is (window × instances). It is a real brake on the naive
 * case at no cost. Move to `rate-limit-redis` when this runs multi-instance.
 */
export const writeLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Health checks must never be throttled — a limited probe reads as an outage.
  skip: (req) => req.path === "/health" || req.path === "/health/live",
  message: {
    error: {
      code: "rate_limited",
      message: "Too many requests. Please wait a few minutes and try again.",
    },
  },
});

/**
 * Road Cover lead intake.
 *
 * Its own bucket rather than `writeLimiter`, because it is a different caller
 * with a different traffic shape: one server posting on behalf of many
 * consumers, so every lead in a campaign spike arrives from a single IP. Under
 * the contact form's 30-per-10-minutes that is an outage disguised as a limit,
 * and a rejected lead is gone — the producer does not retry.
 *
 * 60/minute is generous for the real volume and still a brake on a loop. The
 * response body matches the producer's own error shape rather than this API's
 * envelope, for the reason the 201 does: the contract is already deployed.
 */
export const leadIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Please retry shortly." },
});

/**
 * Final Expense Coverage lead intake.
 *
 * Its own bucket, for the reason the Road Cover one has: one server posting on
 * behalf of many visitors, so every lead in a campaign spike arrives from a
 * single IP and would exhaust `writeLimiter` in seconds. Separate from the Road
 * Cover limiter so a spike on one site cannot throttle the other -- an
 * `express-rate-limit` instance keeps one counter per key, and sharing an
 * instance would share the counter.
 *
 * Unlike the Road Cover one this speaks the API's own error envelope: there is
 * no already-deployed producer contract here to stay compatible with.
 */
export const finalExpenseIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many requests. Please retry shortly.",
    },
  },
});

/**
 * Senior Health Benefits Medicare lead intake.
 *
 * Its own bucket, for the reason the others have one: a single server posting
 * on behalf of many visitors, so every lead in a campaign spike arrives from one
 * IP and would exhaust `writeLimiter` in seconds. A separate instance from the
 * Final Expense limiter so a spike on one site cannot throttle the other --
 * `express-rate-limit` keeps one counter per instance, and sharing an instance
 * would share the counter.
 */
export const seniorHealthIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many requests. Please retry shortly.",
    },
  },
});

/**
 * AffordablePlan lead intake.
 *
 * Its own bucket, for the reason the others have one: a single server posting
 * on behalf of many visitors, so every lead in a campaign spike arrives from one
 * IP and would exhaust `writeLimiter` in seconds. A separate instance from the
 * other limiters so a spike on one site cannot throttle another --
 * `express-rate-limit` keeps one counter per instance, and sharing an instance
 * would share the counter.
 */
export const affordablePlanIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { code: "rate_limited", message: "Too many requests. Please retry shortly." },
  },
});

/**
 * Explore Auto Insurance lead intake.
 *
 * Its own bucket for the same reason as the others: every lead arrives from the
 * site's serverless function, so a campaign spike is many visitors behind a
 * handful of IPs, and a shared counter would let one site throttle another.
 */
export const autoInsuranceIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { code: "rate_limited", message: "Too many requests. Please retry shortly." },
  },
});

/**
 * Disability Benefit Helps lead intake.
 *
 * Its own bucket for the same reason as the others: every lead arrives from the
 * site's serverless function, so a campaign spike is many visitors behind a
 * handful of IPs, and a shared counter would let one site throttle another.
 */
export const socialSecurityIntakeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { code: "rate_limited", message: "Too many requests. Please retry shortly." },
  },
});


/**
 * Onyx availability, called straight from the lead form in a browser.
 *
 * This is the only unauthenticated route on this API, so this limiter is the
 * whole of its protection. Every call spends our paid Onyx credential and
 * pushes a person's details into Onyx under our account, so the ceiling is set
 * for one human filling in one form, not for a server feeding many.
 *
 * Keyed on the client IP, which is real because `app.set("trust proxy", 1)`
 * matches the single Caddy hop in front of this service. Without that the
 * proxy's own address would be the key and the limit would be global.
 *
 * KNOWN LIMIT -- the store is in-process, so the effective ceiling is
 * (max x instances). One instance runs today; move to `rate-limit-redis`
 * before scaling out, or this becomes a limit in name only.
 */
export const onyxAvailabilityLimiter = rateLimit({
  windowMs: 60_000,
  max: env.ONYX_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many availability checks. Please wait a moment and try again.",
    },
  },
});

/**
 * Onyx utilization, called from the operator's browser form.
 *
 * Its own bucket rather than sharing `onyxAvailabilityLimiter`: an
 * `express-rate-limit` instance keeps one counter per key, so sharing one
 * would let traffic on the public lead form throttle the operator tool and
 * vice versa.
 *
 * Like the availability route this is unauthenticated, so this limiter is the
 * whole of its protection -- and this route returns Onyx's answer verbatim,
 * commercial terms included. Tighter than availability because the audience
 * is a handful of operators, not every visitor to a lead form.
 */
export const onyxUtilizationLimiter = rateLimit({
  windowMs: 60_000,
  max: env.ONYX_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many utilization checks. Please wait a moment and try again.",
    },
  },
});

/**
 * Blacklist Alliance lookup, called from the static lookup page.
 *
 * Unauthenticated like the Onyx routes, so this limiter is the whole of its
 * protection, and every call spends a paid lookup. Its own instance so traffic
 * here cannot throttle the Onyx tools, and vice versa. Same in-process KNOWN
 * LIMIT as the others: move to `rate-limit-redis` before scaling out.
 */
export const blacklistLookupLimiter = rateLimit({
  windowMs: 60_000,
  max: env.BLACKLIST_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many lookups. Please wait a moment and try again.",
    },
  },
});

/**
 * CallGrid bid and confirmation, called from the static bid page.
 *
 * Unauthenticated like the Onyx and Blacklist routes, so this limiter is the
 * whole of its protection. Its own instance so traffic here cannot throttle
 * those tools, and vice versa; the bid and its confirmation share it, since
 * they are one flow. Same in-process KNOWN LIMIT as the others.
 */
export const callGridBidLimiter = rateLimit({
  windowMs: 60_000,
  max: env.CALLGRID_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many bid requests. Please wait a moment and try again.",
    },
  },
});
