import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejections from async handlers: a thrown error in
 * one becomes an unhandled rejection and the request hangs until it times out.
 * Wrapping every async handler routes rejections into the error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
