import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { requestIdOf } from "@/api/middleware/requestId";
import { validate } from "@/api/middleware/validate";
import { env, isProduction } from "@/config/env";
import {
  importLeadsSchema,
  leadgenWebhookSchema,
  pageIdParamSchema,
  type ImportLeadsRequest,
} from "@/domain/facebook.schema";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createFacebookLeadService, type FacebookLeadService } from "@/services/facebookLead.service";

/*
 * /api/v1/meta — Facebook Lead Ads.
 *
 * GET  /webhook   Meta's one-time callback check. PUBLIC: Meta sends our own
 *                 META_WEBHOOK_VERIFY_TOKEN back and we echo `hub.challenge`.
 * POST /webhook   `leadgen` deliveries. PUBLIC but signed: the body's
 *                 HMAC-SHA256 under META_APP_SECRET must match
 *                 `x-hub-signature-256`, or the delivery is refused.
 *                 200 once every lead in it is stored (or already was);
 *                 500 if any could not be, so Meta redelivers.
 *
 * Behind the API key, for the CRM:
 * GET  /status                    configuration (never secrets), pages, import progress
 * POST /pages/:pageId/subscribe   subscribe this app to a page's `leadgen` webhooks
 * POST /import                    import existing leads in the background (202)
 * GET  /import                    progress of the last import
 */

/** Exact path, for `app.ts` to give it a raw-body parser ahead of the JSON one. */
export const META_WEBHOOK_PATH = "/api/v1/meta/webhook";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();

/** Raw-body parser for the webhook: the signature is over the exact bytes Meta sent. */
export const metaWebhookBody = express.raw({ type: () => true, limit: "1mb" });

/**
 * Verifies `x-hub-signature-256: sha256=<hex>` over the raw body. Fails closed
 * in production when the app secret is unset, like the other webhooks.
 */
export function verifyMetaSignature(appSecret: () => string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const secret = appSecret();
    if (!secret) {
      if (isProduction) return next(new UnauthorizedError("The Meta app secret is not configured."));
      logger.warn({ path: req.path }, "META_APP_SECRET unset - Facebook webhook is unsigned (non-production)");
      return next();
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.get("x-hub-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    // Both sides hashed to a fixed width, so the comparison leaks neither content nor length.
    if (!header || !timingSafeEqual(digest(header), digest(expected))) {
      logger.warn({ requestId: requestIdOf(req) }, "Rejected Facebook webhook with an invalid signature");
      return next(new UnauthorizedError("Missing or invalid webhook signature."));
    }
    next();
  };
}

export function metaRouter(
  service: FacebookLeadService = createFacebookLeadService(),
  config: { appSecret: () => string | undefined; verifyToken: () => string | undefined } = {
    appSecret: () => env.META_APP_SECRET,
    verifyToken: () => env.META_WEBHOOK_VERIFY_TOKEN,
  },
): Router {
  const router = Router();

  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expected = config.verifyToken();
    const valid =
      mode === "subscribe" &&
      typeof token === "string" &&
      expected !== undefined &&
      timingSafeEqual(digest(token), digest(expected)) &&
      typeof challenge === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(challenge);
    if (!valid) {
      logger.warn({ requestId: requestIdOf(req), configured: expected !== undefined }, "Refused Facebook webhook verification");
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    logger.info("Facebook webhook verified");
    // Plain text, and only a checked token: echoing input as HTML would be reflected XSS.
    res.status(200).type("text/plain").send(challenge);
  });

  router.post(
    "/webhook",
    verifyMetaSignature(config.appSecret),
    asyncHandler(async (req, res) => {
      let json: unknown;
      try {
        json = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
      } catch {
        throw new ValidationError({ fieldErrors: { _: "Expected a JSON body." } });
      }
      const parsed = leadgenWebhookSchema.safeParse(json);
      if (!parsed.success) throw new ValidationError({ fieldErrors: { _: "Not a webhook delivery." } });

      const result = await service.handleWebhook(parsed.data);
      res.status(200).json({ data: result });
    }),
  );

  router.get(
    "/status",
    apiKeyAuth,
    asyncHandler(async (req, res) => {
      res.json({
        data: {
          appId: env.META_APP_ID ?? null,
          /* As this request reached us, which behind the one trusted proxy is
             the public scheme and host -- the value to paste into Meta. */
          webhookUrl: `${req.protocol}://${req.get("host")}${META_WEBHOOK_PATH}`,
          appSecretConfigured: Boolean(config.appSecret()),
          verifyTokenConfigured: Boolean(config.verifyToken()),
          webhookPath: META_WEBHOOK_PATH,
          graphApiVersion: env.META_GRAPH_API_VERSION,
          pages: await service.pages(),
          import: service.importState(),
        },
      });
    }),
  );

  router.post(
    "/pages/:pageId/subscribe",
    apiKeyAuth,
    validate(pageIdParamSchema, "params"),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.subscribe((req.params as { pageId: string }).pageId) });
    }),
  );

  router.get("/import", apiKeyAuth, (_req, res) => {
    res.json({ data: service.importState() });
  });

  router.post(
    "/import",
    apiKeyAuth,
    validate(importLeadsSchema),
    asyncHandler(async (req, res) => {
      res.status(202).json({ data: service.startImport(req.body as ImportLeadsRequest) });
    }),
  );

  return router;
}

