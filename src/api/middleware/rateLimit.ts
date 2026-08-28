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
