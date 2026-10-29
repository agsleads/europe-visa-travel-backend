import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { env, isProduction, isTest } from "@/config/env";
import { errorHandler, notFoundHandler } from "@/api/middleware/errorHandler";
import { requestId, requestIdOf } from "@/api/middleware/requestId";
import { enquiriesRouter } from "@/api/routes/enquiries.routes";
import { usersRouter } from "@/api/routes/users.routes";
import { notificationsRouter } from "@/api/routes/notifications.routes";
import { domainsRouter } from "@/api/routes/domains.routes";
import { META_WEBHOOK_PATH, metaRouter, metaWebhookBody } from "@/api/routes/meta.routes";
import type { FacebookLeadService } from "@/services/facebookLead.service";
import type { DomainRepository } from "@/repositories/domain.repository";
import { finalExpenseRouter } from "@/api/routes/finalexpense.routes";
import { seniorHealthRouter } from "@/api/routes/seniorhealth.routes";
import { affordablePlanRouter } from "@/api/routes/affordableplan.routes";
import { autoInsuranceRouter } from "@/api/routes/autoinsurance.routes";
import { socialSecurityRouter } from "@/api/routes/socialsecurity.routes";
import { leadsRouter } from "@/api/routes/leads.routes";
import { onyxRouter } from "@/api/routes/onyx.routes";
import { blacklistRouter } from "@/api/routes/blacklist.routes";
import { callGridRouter } from "@/api/routes/callgrid.routes";
import { healthRouter } from "@/api/routes/health.routes";
import { logger } from "@/lib/logger";
import type { EnquiryService } from "@/services/enquiry.service";
import type { UserService } from "@/services/user.service";
import type { NotificationService } from "@/services/notification.service";
import type { FinalExpenseService } from "@/services/finalexpense.service";
import type { LeadService } from "@/services/lead.service";
import type { SeniorHealthService } from "@/services/seniorhealth.service";
import type { AffordablePlanService } from "@/services/affordableplan.service";
import type { AutoInsuranceService } from "@/services/autoinsurance.service";
import type { SocialSecurityService } from "@/services/socialsecurity.service";
import type { OnyxClient } from "@/services/onyx.client";
import type { BlacklistClient } from "@/services/blacklist.client";
import type { CallGridClient } from "@/services/callgrid.client";

/**
 * The app is built by a factory, not created at import time. Tests construct
 * one per suite with a fake service injected, and nothing binds a port or
 * opens a connection as a side effect of `import`.
 */
export function createApp(
  deps: {
    enquiryService?: EnquiryService;
    userService?: UserService;
    notificationService?: NotificationService;
    domainRepository?: DomainRepository;
    facebookLeadService?: FacebookLeadService;
    leadService?: LeadService;
    finalExpenseService?: FinalExpenseService;
    seniorHealthService?: SeniorHealthService;
    affordablePlanService?: AffordablePlanService;
    autoInsuranceService?: AutoInsuranceService;
    socialSecurityService?: SocialSecurityService;
    onyxClient?: OnyxClient;
    blacklistClient?: BlacklistClient;
    blacklistAllowedIps?: readonly string[];
    callGridClient?: CallGridClient;
  } = {},
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
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-api-key", "x-request-id", "x-actor-id", "x-actor-name"],
      maxAge: 86_400,
    }),
  );

  app.use(compression());

  /* Body cap. The message field is capped at 2000 characters by the schema,
     but the schema only runs after the body is buffered — the limit here is
     what stops a 100 MB POST being read into memory in the first place. */
  /* Except the Facebook webhook, whose signature is over the exact bytes Meta
     sent: it gets them raw, and a body already read is skipped by the JSON
     parser. Its own limit too, since one delivery can batch many leads. */
  app.use(META_WEBHOOK_PATH, metaWebhookBody);
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
  /* The CRM's user directory: the people who work enquiries. */
  app.use("/api/v1/users", usersRouter(deps.userService));
  /* In-app notifications for CRM users. */
  app.use("/api/v1/notifications", notificationsRouter(deps.notificationService));
  /* The lead businesses CRM users belong to. */
  app.use("/api/v1/domains", domainsRouter(deps.domainRepository));
  /* Facebook Lead Ads: the leadgen webhook, and the CRM's page and import controls. */
  app.use("/api/v1/meta", metaRouter(deps.facebookLeadService));
  /* Road Cover lead intake and its operator reads. Namespaced by producer
     rather than mounted as a second top-level resource: the payload, the
     credential and the retention rules all belong to that partner, and a flat
     /api/v1/leads would read as though this service had one lead concept. */
  app.use("/api/v1/roadcover/leads", leadsRouter(deps.leadService));
  /* Final Expense Coverage lead intake, namespaced by producer for the same
     reason: its own payload, its own credential, its own retention. */
  app.use("/api/v1/finalexpense/leads", finalExpenseRouter(deps.finalExpenseService));
  /* Senior Health Benefits Medicare lead intake, namespaced by producer for
     the same reason: its own payload, its own credential, its own retention. */
  app.use("/api/v1/seniorhealth/leads", seniorHealthRouter(deps.seniorHealthService));
  app.use("/api/v1/affordableplan/leads", affordablePlanRouter(deps.affordablePlanService));
  app.use("/api/v1/autoinsurance/leads", autoInsuranceRouter(deps.autoInsuranceService));
  /* Disability Benefit Helps (the social-security site) free case review
     requests, namespaced by producer like the others. */
  app.use("/api/v1/socialsecurity/leads", socialSecurityRouter(deps.socialSecurityService));
  app.use("/api/v1/onyx", onyxRouter(deps.onyxClient));
  /* Blacklist Alliance single-number lookup; stores nothing. */
  app.use("/api/v1/blacklist", blacklistRouter(deps.blacklistClient, deps.blacklistAllowedIps));
  /* CallGrid real-time bids and their confirmations; stores nothing. */
  app.use("/api/v1/callgrid", callGridRouter(deps.callGridClient));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
