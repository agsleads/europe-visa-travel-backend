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
