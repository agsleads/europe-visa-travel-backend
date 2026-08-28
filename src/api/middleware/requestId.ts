import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Correlation id for every request, echoed on the response so a user-reported
 * failure can be traced to exact log lines.
 *
 * `Request.id` is not declared here: pino-http already augments Express with
 * `id: ReqId` (string | number | object). A second, narrower declaration of
 * the same property is a compile error, so this writes into pino's field and
 * `requestIdOf` narrows it back to a string at the point of use.
 *
 * An inbound `x-request-id` is honoured (the Next.js server sets one, so a
 * frontend log line and an API log line share an id) but is length-capped and
 * character-filtered first: it is attacker-controlled and ends up in both a
 * response header and every log line, which is how header injection and log
 * forging start.
 */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get("x-request-id");
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  req.id = id;
  res.setHeader("x-request-id", id);
  next();
}

/** Reads the correlation id back as a string, whatever pino's type allows. */
export function requestIdOf(req: Request): string {
  return typeof req.id === "string" ? req.id : String(req.id ?? "unknown");
}
