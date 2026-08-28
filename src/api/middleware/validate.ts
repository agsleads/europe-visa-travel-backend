import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny, z } from "zod";

import { ValidationError } from "@/lib/errors";

type Source = "body" | "query" | "params";

/**
 * Validates one part of the request and *replaces* it with the parsed result,
 * so handlers downstream receive the coerced, trimmed, type-safe value rather
 * than the raw input. Returning field-keyed messages means the frontend can
 * map them straight onto its own fields.
 */
export function validate<S extends ZodTypeAny>(schema: S, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join(".") || "_";
        // First issue per field wins — one clear message beats a stack.
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return next(new ValidationError({ fieldErrors }));
    }

    /* `req.query` is a getter-only property on Express 5 and a plain object on
       4; assigning through defineProperty works on both. */
    Object.defineProperty(req, source, {
      value: result.data as z.infer<S>,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
