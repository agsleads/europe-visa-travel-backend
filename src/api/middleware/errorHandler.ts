import type { NextFunction, Request, Response } from "express";

import { isProduction } from "@/config/env";
import { AppError, NotFoundError } from "@/lib/errors";
import { requestIdOf } from "@/api/middleware/requestId";
import { logger } from "@/lib/logger";

/** Terminal 404 — reached only when no route matched. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Cannot ${req.method} ${req.path}`));
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

/**
 * Errors raised by Express's own middleware — body-parser's `entity.too.large`
 * and `entity.parse.failed` above all — are not AppErrors but do carry an
 * accurate `status` and a safe, generic `type`. Without this they collapse to
 * a 500, which tells a caller "our fault, retry" when the truth is "your
 * request was 200 kB / was not JSON". The message is *not* passed through:
 * body-parser's text can echo a fragment of the offending payload.
 */
function fromMiddlewareError(
  error: unknown,
): { status: number; code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  // Only client errors are trusted from a third party; a 5xx `status` on an
  // arbitrary error object is not evidence of anything.
  if (typeof status !== "number" || status < 400 || status >= 500) return null;

  const type = typeof candidate.type === "string" ? candidate.type : "";
  if (type === "entity.too.large") {
    return { status, code: "payload_too_large", message: "The request body is too large." };
  }
  if (type === "entity.parse.failed" || type === "encoding.unsupported") {
    return { status, code: "malformed_body", message: "The request body could not be parsed." };
  }
  return { status, code: "bad_request", message: "The request could not be processed." };
}

/**
 * The single place an error becomes a response.
 *
 * Two rules hold everywhere below. Unknown errors return a generic message —
 * a raw `error.message` from pg leaks table names, column names and sometimes
 * the offending value, which for this table is personal data. And the request
 * id goes in every body, so a user can quote it and it maps to a log line.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  /* Express cannot switch to an error response once headers are out; hand it
     back so the connection is destroyed rather than left half-written. */
  if (res.headersSent) return next(error);

  const known = error instanceof AppError;
  const middleware = known ? null : fromMiddlewareError(error);
  const status = known ? error.status : (middleware?.status ?? 500);

  const id = requestIdOf(req);
  const logPayload = { err: error, requestId: id, method: req.method, path: req.path };
  if (status >= 500) logger.error(logPayload, "Request failed");
  else logger.warn(logPayload, "Request rejected");

  const body: ErrorBody = {
    error: {
      code: known ? error.code : (middleware?.code ?? "internal_error"),
      message: known
        ? error.message
        : (middleware?.message ??
          "Something went wrong. Please try again, or contact us directly."),
      requestId: id,
    },
  };

  if (known && error.details !== undefined) body.error.details = error.details;

  // Stack traces are a development aid only; in production they are a map of
  // the codebase handed to whoever triggered the error.
  if (!isProduction && !known && !middleware && error instanceof Error) {
    body.error.details = { message: error.message, stack: error.stack };
  }

  res.status(status).json(body);
}
