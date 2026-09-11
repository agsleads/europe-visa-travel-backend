import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { env, isProduction, isTest } from "@/config/env";
import { errorHandler, notFoundHandler } from "@/api/middleware/errorHandler";
import { requestId, requestIdOf } from "@/api/middleware/requestId";
import { enquiriesRouter } from "@/api/routes/enquiries.routes";
import { leadsRouter } from "@/api/routes/leads.routes";
import { healthRouter } from "@/api/routes/health.routes";
import { logger } from "@/lib/logger";
import type { EnquiryService } from "@/services/enquiry.service";
import type { LeadService } from "@/services/lead.service";

/**
 * The app is built by a factory, not created at import time. Tests construct
 * one per suite with a fake service injected, and nothing binds a port or
 * opens a connection as a side effect of `import`.
 */
export function createApp(
  deps: { enquiryService?: EnquiryService; leadService?: LeadService } = {},
): Express {
  const app = express();

  /* Behind Vercel / a load balancer, `req.ip` is the proxy unless Express is
     told to trust it — and the rate limiter keys on `req.ip`, so without this
     every request shares one bucket. `1` (trust one hop) rather than `true`:
     trusting every hop lets a client forge x-forwarded-for and reset its own
     limit at will. */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId);

  /* API-only service: no HTML is served, so the CSP and framing directives
     protect nothing and only complicate responses. The transport and
     content-type protections do matter and stay on. */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors({
      /* Allowlist, never `origin: true` — reflecting any origin with
         credentials enabled is equivalent to having no CORS policy at all.
         An empty list means "no browser origin", which is the correct
         default for a server-to-server API. */
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-api-key", "x-request-id"],
      maxAge: 86_400,
    }),
  );

  app.use(compression());

  /* Body cap. The message field is capped at 2000 characters by the schema,
     but the schema only runs after the body is buffered — the limit here is
     what stops a 100 MB POST being read into memory in the first place. */
  app.use(express.json({ limit: "64kb" }));

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => requestIdOf(req as unknown as Parameters<typeof requestIdOf>[0]),
        // 4xx is the client's mistake, not an application error; logging it at
        // `error` level makes real errors impossible to find.
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      }),
    );
  }

  app.use(healthRouter());
  /* Versioned prefix from day one. Adding /v2 later is routine; retrofitting a
     version onto an unversioned path that a deployed frontend already calls
     is not. */
  app.use("/api/v1/enquiries", enquiriesRouter(deps.enquiryService));
  /* Road Cover lead intake and its operator reads. Namespaced by producer
     rather than mounted as a second top-level resource: the payload, the
     credential and the retention rules all belong to that partner, and a flat
     /api/v1/leads would read as though this service had one lead concept. */
  app.use("/api/v1/roadcover/leads", leadsRouter(deps.leadService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
