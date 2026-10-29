import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

import { requestIdOf } from "@/api/middleware/requestId";
import { AppError } from "@/lib/errors";
import { buildAllowlist, normalise } from "@/lib/ipList";
import { logger } from "@/lib/logger";

/**
 * Lets a route be called only from listed addresses: single IPs
 * (`58.65.176.229`) or CIDR ranges (`2407:d000:1c:2553::/64`), IPv4 or IPv6.
 *
 * Keyed on `req.ip`, which is the real client only because the app trusts
 * exactly one proxy hop (Caddy). Behind a second proxy that does not set
 * X-Forwarded-For, every request would carry the proxy's address and this
 * list would either admit everyone or no one.
 *
 * An empty list admits everyone, so a route keeps working until a list is
 * configured for it.
 */

export function ipAllowlist(entries: readonly string[]) {
  const list = buildAllowlist(entries);

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (entries.length === 0) return next();

    const ip = normalise(req.ip ?? "");
    const version = isIP(ip);
    if (version !== 0 && list.check(ip, version === 4 ? "ipv4" : "ipv6")) return next();

    logger.warn({ requestId: requestIdOf(req), ip, path: req.originalUrl }, "Rejected request from an IP not on the allowlist");
    /* The caller's own address goes back in the message: it is theirs to see,
       and it is the one thing they need to get it added. */
    next(
      new AppError(`This service is not available from your network (${ip || "unknown address"}).`, {
        status: 403,
        code: "ip_not_allowed",
      }),
    );
  };
}
