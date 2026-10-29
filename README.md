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
| GET    | `/enquiries`           | List. Filters `?status=&group=&priority=&assignedTo=&destination=&visaType=&q=&from=&to=`, order `?sort=&order=`, page `?limit=&offset=` |
| GET    | `/enquiries/stats`     | Pipeline counts, by status/priority/destination/visa type/assignee, monthly volume. `?assignedTo=&from=&to=` |
| GET    | `/enquiries/facets`    | Distinct destinations and visa types, for filter controls. |
| GET    | `/enquiries/follow-ups`| Follow-ups across enquiries. `?assignedTo=&open=true&limit=` |
| GET    | `/enquiries/activity`  | Latest activity across enquiries. `?assignedTo=&limit=` |
| POST   | `/enquiries/bulk-assign` | `{ ids, assignee }` — assign many; `assignee: null` unassigns. |
| GET    | `/enquiries/:id`       | Fetch one.                                 |
| PATCH  | `/enquiries/:id`       | `{ status?, priority? }`                   |
| PATCH  | `/enquiries/:id/status`| `{ status }` — kept for status-only callers. |
| PUT    | `/enquiries/:id/assignee` | `{ assignee: { id, name } }` to assign or reassign, `null` to unassign. |
| POST   | `/enquiries/:id/contacts` | `{ channel: call · email · whatsapp }` — logs outreach, stamps `lastContactAt`. |
| GET    | `/enquiries/:id/activity` | The enquiry's history, newest first.    |
| GET/POST | `/enquiries/:id/notes` | List / add notes.                        |
| PATCH/DELETE | `/enquiries/:id/notes/:noteId` | Edit / delete a note.         |
| GET/POST | `/enquiries/:id/follow-ups` | List / schedule follow-ups `{ title, dueAt }`. |
| PATCH/DELETE | `/enquiries/:id/follow-ups/:followUpId` | `{ completed }` / delete. |
| GET    | `/health`              | Readiness — checks PostgreSQL, `503` if down. |
| GET    | `/health/live`         | Liveness — process only, never the database. |

### CRM users and domains

The CRM's user directory (`crm_users`, migrations 015 and 018). All under
`/api/v1/users`, all requiring `x-api-key`. Responses never include the
password hash.

**Roles**, highest first:

- `super_admin` — spans every domain and has none (`domain: null`). Manages
  admins and users in every domain.
- `admin` — belongs to one domain and manages that domain's users.
- `user` — belongs to one domain and works its leads.

A **domain** is one lead business (`crm_domains`, seeded by migration 018):
`evc`, `roadcover`, `finalexpense`, `seniorhealth`, `affordableplan`,
`autoinsurance`, `socialsecurity`. Migration 018 put every existing admin and
user in `evc`; nobody is made a super admin by migration.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/domains` | The domains, `{ key, name, description }`. |
| GET    | `/users` | List, newest first. `?q=&role=&status=&domain=` |
| POST   | `/users` | `{ username, name, email, phone?, role, domain, status, jobTitle?, password }` — `domain` required unless `super_admin`; `409` if the username or email exists. |
| GET    | `/users/:id` | Fetch one. |
| PATCH  | `/users/:id` | Any of `username, name, email, phone, role, domain, status, jobTitle, avatarUrl`. Promoting to `super_admin` clears the domain. |
| DELETE | `/users/:id` | `204`. |
| PUT    | `/users/:id/password` | Reset by someone above them: `{ password }`. |
| POST   | `/users/:id/password/change` | Self-service `{ currentPassword, newPassword }` — **super admins only**; `403 password_managed` for admins and users. |
| POST   | `/users/authenticate` | `{ login, password }` — `login` is the username or email → the user; `401` wrong credentials, `403` deactivated. |

Passwords are hashed with scrypt (node:crypto). The last active super admin
cannot be deleted, deactivated or demoted (`409 last_super_admin`). Which CRM
user may manage whom (admins only their own domain's users) is enforced by the
CRM. Create the first super admin with:

```
CRM_ADMIN_PASSWORD='…' npx tsx src/db/create-crm-admin.ts <username> <email> "<name>" ["<phone>"]
# in the container: node dist/db/create-crm-admin.js …
```

### CRM notifications

In-app notifications for CRM users (`crm_notifications`, migration 016). All
under `/api/v1/notifications`, all requiring `x-api-key`. Every route on an
existing notification takes `?userId=` and only touches that user's own; a
notification is deleted with its user.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/notifications?userId=` | Newest first, with `unreadCount`. `&unread=true&limit=` |
| POST   | `/notifications` | `{ recipients[], type, title, message, link? }` — one per recipient; unknown users skipped. |
| GET    | `/notifications/:id?userId=` | Fetch one. |
| PATCH  | `/notifications/:id?userId=` | `{ read }` |
| POST   | `/notifications/read-all` | `{ userId }` → `{ updated }` |
| DELETE | `/notifications/:id?userId=` | `204`. |

Types: `lead_assigned · status_changed · follow_up_due · user_added · lead_converted`.
`link` must be an in-app path (`/leads/42`), never an absolute URL.

### Enquiries as CRM leads

Every enquiry is worked as a lead by the CRM (`crm-frontend`) and the EVC admin
console:

- **Status** is the CRM's list, each in a group used for reporting
  (`STATUS_GROUP` in `src/domain/enquiry.schema.ts`):
  - *open* — `new`, `no_response`, `follow_up_required`, `conversation_ongoing`,
    `call_scheduled`, `call_rescheduled`, `interested`, `documents_pending`,
    `awaiting_payment`, `pre_closed`
  - *on hold* — `travel_date_deferred`
  - *won* — `closed`
  - *lost* — `visa_shopping`, `irrelevant_inquiry`, `not_eligible`,
    `not_interested`, `duplicate_lead`

  `/stats` counts the won group as `converted` and adds a `byGroup` rollup.
  Migration 017 mapped the previous pipeline across: `contacted` →
  `conversation_ongoing`, `qualified` → `interested`, `proposal` →
  `awaiting_payment`, `converted` → `closed`, `lost` → `not_interested`.
- **Priority** is `low · medium · high · urgent`, default `medium`.
- **Assignee** is stored as an opaque CRM user id *and* display name, because
  the CRM's user directory lives outside this service.
- **Every change is recorded** in `enquiry_activities` in the same transaction
  as the change itself: creation, (re/un)assignment, status and priority
  changes, logged calls/emails/WhatsApps, notes and follow-ups.
- **Attribution** comes from `x-actor-id` / `x-actor-name` headers, asserted
  by the calling server. It is recorded, never used to grant access: which rep
  may see which lead is the calling console's responsibility.

### Facebook Lead Ads

Leads from Facebook and Instagram Instant Forms are stored in `enquiries` with
`source = 'facebook'`, so the CRM works them like any website enquiry. Meta's
lead id is kept in `external_id`, unique per source, so a lead delivered twice
(a webhook retry, or an import overlapping the webhook) is stored once. Every
form answer, plus the page, form, ad and campaign ids, is in `lead_details`.

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/api/v1/meta/webhook` | `META_WEBHOOK_VERIFY_TOKEN` | Meta's callback verification; echoes `hub.challenge` |
| POST | `/api/v1/meta/webhook` | `x-hub-signature-256` (HMAC of the raw body with `META_APP_SECRET`) | `leadgen` deliveries. 200 when every lead is stored; 500 if any failed, so Meta redelivers |
| GET | `/api/v1/meta/status` | API key | Configuration flags (never secrets), each page's subscription, import progress |
| POST | `/api/v1/meta/pages/:pageId/subscribe` | API key | Subscribes the app to a page's `leadgen` field |
| POST | `/api/v1/meta/import` | API key | `{ pageId?, formId?, since? }`. Imports existing leads in the background (202) |
| GET | `/api/v1/meta/import` | API key | Progress of the last import |

The webhook only carries a lead id; the lead is fetched from the Graph API
with that page's token from `META_PAGE_ACCESS_TOKENS`. Standard questions map
by key (`full_name`, `email`, `phone_number`); custom questions mentioning a
destination, visa or travel date fill those columns, and every other answer is
listed in the message. Fields a form did not ask for read "Not specified".
Logs carry ids only, never lead data or tokens.

### Final Expense Coverage leads

Leads from finalexpensecoverage.us: its home-page quote form and its contact
page, which collect the same fields. The intake authenticates with its own
secret, not `x-api-key`; the reads use `x-api-key` like everything else.

| Method | Path                               | Auth                        | Purpose |
| ------ | ---------------------------------- | --------------------------- | ------- |
| POST   | `/finalexpense/leads`              | `x-finalexpense-signature`  | Create a lead. `201`, or `200` with the original id for a retried submission. |
| GET    | `/finalexpense/leads`              | `x-api-key`                 | List, newest first. `?q=&limit=&offset=`. No date of birth. |
| GET    | `/finalexpense/leads/stats`        | `x-api-key`                 | Total, today (UTC), last 7 and 30 days. |
| GET    | `/finalexpense/leads/:id`          | `x-api-key`                 | One lead with date of birth, consent record and raw body. |

The POST body is `{ submissionId, receivedAt, source, answers: { firstName,
lastName, phone, email, zip, dateOfBirth }, consent: { text,
version, timestamp }, audit?: { ipAddress, userAgent } }`. `submissionId` is the
idempotency key: the site keeps it across a retry, so a submit that reached us
but lost its response is recorded once. Tables are in migration `003`; the
consent table is append-only and `ON DELETE RESTRICT`, like Road Cover's.

### Blacklist Alliance lookup

Checks one phone number against the Blacklist Alliance databases (litigators,
federal and state DNC). Stores nothing. **Public, no API key**: the caller is the
static `blacklist-lookup` page, so it relies on `BLACKLIST_RATE_LIMIT_MAX`
(per IP, per minute) and `CORS_ORIGINS` instead. Every call is a paid lookup.

| Method | Path                  | Auth | Purpose |
| ------ | --------------------- | ---- | ------- |
| POST   | `/blacklist/lookup`   | none | `{ phone }` → `200 { data: <provider response> }`. |

`phone` is a 10-digit US number; punctuation and a leading `+1`/`1` are
stripped. Upstream this is `GET https://api.blacklistalliance.net/lookup?key=…&phone=…&resp=json`.
The key goes in the query string, so that URL is never logged. The response's
`message` is the verdict (`Good`, `Blacklisted`, `Suppressed`, `FederalDNC`,
`StateDNC`) and `code` lists the matching databases. A provider 422 (invalid
number) comes back as a `phone` field error. Any other refusal is a `502
blacklist_rejected` with `upstreamStatus` and `upstreamMessage`. A 403 there
means our key is wrong. An unset `BLACKLIST_ALLIANCE_API_KEY` answers `503`.
Test numbers: `2223334444` (good), `9999999999` (blacklisted).

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

Two callers hold the API key, both server-side:

- the public contact form's Server Action, which creates enquiries; and
- the **admin console** at `/admin` in the Next.js app, which reads them.

Two lead producers hold their own secrets instead, also server-side only:
roadcover.us (`ROADCOVER_WEBHOOK_SECRET`) and finalexpensecoverage.us
(`FINALEXPENSE_WEBHOOK_SECRET`). Neither secret can read anything.

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
- **Retention** is `enquiryService.purge()`, deleting rows in the lost status
  group past `ENQUIRY_RETENTION_DAYS` together with their notes, follow-ups and
  activity. Won and on-hold leads are kept. It is not scheduled yet — see below.

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
