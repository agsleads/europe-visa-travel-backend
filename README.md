# Europe Visa Centre — Enquiry API

Express + PostgreSQL service that stores enquiries submitted through the site's
`/contact` form.

## Why a separate service

The Next.js Server Action stays the form's front door — it keeps the HMAC
timing token, the honeypot, the per-IP rate limit and the no-JavaScript
progressive enhancement that already worked. What it gained is a durable
record: before, a submission existed only as an email that was never sent.

```
browser ──POST(form)──▶ Next.js Server Action ──POST /api/v1/enquiries──▶ Express ──▶ PostgreSQL
                        (spam checks, zod)        (x-api-key, server-side only)
```

The browser never calls this API. The key lives on the Next.js server, and
`lib/api/client.ts` imports `server-only` so a Client Component importing it
fails the build rather than shipping the key to the browser.

## Getting started

```bash
createdb evc                # or: docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
cp .env.example .env        # set DATABASE_URL and API_KEY
npm install
npm run migrate
npm run dev                 # http://localhost:4000
```

Then in the frontend's `.env.local`:

```
ENQUIRY_API_URL=http://localhost:4000
ENQUIRY_API_KEY=<the same value as API_KEY above>
```

Leave `ENQUIRY_API_URL` unset to run the site without this service — the form
still validates and renders success, it just does not persist.

## Endpoints

All under `/api/v1`, all requiring `x-api-key`.

| Method | Path                   | Purpose                                    |
| ------ | ---------------------- | ------------------------------------------ |
| POST   | `/enquiries`           | Create an enquiry. `201` with the reference. |
| GET    | `/enquiries`           | List, newest first. `?status=&q=&limit=&offset=` |
| GET    | `/enquiries/stats`     | Counts per status, total, and the trailing week. |
| GET    | `/enquiries/:id`       | Fetch one.                                 |
| PATCH  | `/enquiries/:id/status`| `new · in_progress · responded · closed · spam` |
| GET    | `/health`              | Readiness — checks PostgreSQL, `503` if down. |
| GET    | `/health/live`         | Liveness — process only, never the database. |

`?q=` searches reference, name, email, destination and message. It uses
`POSITION`, not `LIKE`, so `%` and `_` in a search term are literal characters
rather than wildcards — otherwise searching for "50%" would match every row.

`/enquiries/stats` is registered **before** `/:id`. Express matches in
declaration order, so reversing them makes "stats" parse as an enquiry id and
return a 422. There is a test pinning that ordering.

Errors are uniform:

```json
{ "error": { "code": "validation_failed", "message": "…", "details": { "fieldErrors": { "email": "…" } }, "requestId": "…" } }
```

`fieldErrors` is keyed by field name, so the Server Action maps it straight
onto the form's own inputs.

## Testing

```bash
npm test                    # unit + HTTP, no database needed
TEST_DATABASE_URL=postgresql://localhost:5432/evc_test npm test   # + integration
npm run test:coverage
```

Unit and HTTP tests run the real app — real middleware, real routing, real
error handler — with only the repository faked, so the wiring is covered.
Integration tests exercise the SQL, the constraints, the trigger and the
migration runner against a real database, and are **skipped** unless
`TEST_DATABASE_URL` is set. Point it at a throwaway database: the suite
truncates the table before every test.

## Who calls this

Two callers, both server-side, both holding the API key:

- the public contact form's Server Action, which creates enquiries; and
- the **admin console** at `/admin` in the Next.js app, which reads them.

The console authenticates its operator against its own session cookie before
calling anything here — see `lib/admin/auth.ts` in the frontend. There is no
users table: a single credential lives in the frontend environment. The browser
never holds this API key, so the key is not acting as a human authorisation
model; the session in front of it is.

## Architecture

```
src/
  api/          Express app factory, routes, middleware
  config/       Environment, validated at boot
  db/           Pool, migration runner, .sql migrations
  domain/       Zod schemas and types
  repositories/ SQL. Nothing above this layer sees a query string.
  services/     Business rules. Repository injected, so unit-testable.
```

The app is built by a factory (`createApp({ enquiryService })`) rather than
created at import time, so tests construct one per suite with a fake injected
and nothing binds a port as a side effect of `import`.

## Operational notes

- **Migrations are immutable.** The runner records a checksum per file and
  refuses to start if an already-applied migration was edited. Add a new file.
- **Rate limiting is in-process.** On more than one instance the effective
  limit is (window × instances). Move to `rate-limit-redis` before scaling out.
- **Logs never carry payloads.** Bodies and personal fields are redacted at the
  logger; log the enquiry id or reference instead.
- **The client IP is never stored raw** — only the salted hash the frontend
  already computes for rate limiting, for abuse correlation and nothing else.
- **Retention** is `enquiryService.purge()`, deleting closed and spam rows past
  `ENQUIRY_RETENTION_DAYS`. It is not scheduled yet — see below.

## Before production

- [ ] Set `API_KEY`; the process refuses to boot in production without it.
- [ ] Run `npm run migrate:prod` as a release step, before the new build serves.
- [ ] Schedule `purge()` (a cron job or `pg_cron`), and set the frontend's
      `RETENTION_PERIOD` to match. A published retention period nothing
      enforces is worse than none.
- [ ] Give the admin console per-user identity when a second person needs a
      login, or when an action needs attributing to a named operator. Today one
      shared credential gates it and this API cannot tell operators apart, so
      there is no access log worth the name.
- [ ] Wire a real email provider in the Server Action's `sendEmail`, or move
      notification here with a retry, so a stored enquiry cannot sit unread.
