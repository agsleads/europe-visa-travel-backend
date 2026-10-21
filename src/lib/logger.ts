import pino from "pino";

import { env, isProduction } from "@/config/env";

/**
 * Structured logging.
 *
 * REDACTION IS NOT OPTIONAL HERE. Enquiry payloads carry names, email
 * addresses and free text, and platform stdout is a retained, searchable
 * store. The redaction paths below cover every route a payload could take
 * into a log line; log identifiers (enquiry id, reference) rather than
 * content, and this stays true.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    /*
     * Targeted paths, not wildcards. A `*.message` here also matches
     * `err.message` and blanks out the one line that says what actually went
     * wrong — redaction that hides the incident instead of the personal data.
     * Enquiry payloads only ever reach a log through one of the containers
     * named below, so naming them is both sufficient and safe.
     */
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-api-key"]',
      /* Every producer's webhook secret arrives in its own header, so each
         needs its own path -- none is covered by x-api-key above. Without
         these, a partner's shared secret is written to disk on every lead. */
      'req.headers["x-roadcover-signature"]',
      'req.headers["x-finalexpense-signature"]',
      'req.headers["x-seniorhealth-signature"]',
      'req.headers["x-affordableplan-signature"]',
      'req.headers["x-autoinsurance-signature"]',
      'req.headers["x-socialsecurity-signature"]',
      "req.body",
      "res.body",
      "body",
      "payload",
      "input",
      "enquiry",
      "data",
    ],
    censor: "[redacted]",
  },
  transport: isProduction ? undefined : { target: "pino/file", options: { destination: 1 } },
});
