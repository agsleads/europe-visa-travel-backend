import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createLeadService, type LeadService } from "@/services/lead.service";
import {
  createFakeLeadRepository,
  minimalLeadPayload,
  validLeadPayload,
} from "../helpers/fakeLeadRepository";

const API_KEY = process.env.API_KEY as string;
const WEBHOOK_SECRET = process.env.ROADCOVER_WEBHOOK_SECRET as string;

const INTAKE = "/api/v1/roadcover/leads";

/**
 * Full HTTP tests through the real app — real middleware, real routing, real
 * error handler — with only the repository faked.
 *
 * The cases below are the producer's own acceptance list from BACKEND-PROMPT.md
 * section 7, because those are the ones the deployed Road Cover site will
 * actually exercise.
 */
describe("POST /api/v1/roadcover/leads", () => {
  let repository: ReturnType<typeof createFakeLeadRepository>;
  let service: LeadService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeLeadRepository();
    service = createLeadService(repository);
    app = createApp({ leadService: service });
  });

  const post = (body: unknown) =>
    request(app).post(INTAKE).set("x-roadcover-signature", WEBHOOK_SECRET).send(body as object);

  it("records a valid lead and returns 201 with its id", async () => {
    const response = await post(validLeadPayload());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, duplicate: false });
    expect(response.body.id).toBeGreaterThan(0);
    expect(response.headers.location).toBe(`${INTAKE}/${response.body.id}`);
    expect(repository.rows).toHaveLength(1);
  });

  it("derives the normalised phone and email alongside the raw values", async () => {
    await post(validLeadPayload());

    const lead = repository.rows[0]!;
    expect(lead.phoneRaw).toBe("(305) 555-0147");
    expect(lead.phoneE164).toBe("+13055550147");
    expect(lead.emailNormalised).toBe("dana@example.com");
    // The string answers become numbers at the persistence boundary.
    expect(lead.age).toBe(34);
    expect(lead.vehicleYear).toBe(2021);
    expect(lead.currentlyInsured).toBe(true);
  });

  it("keeps both states when the consumer overrode the ZIP-derived one", async () => {
    await post(
      validLeadPayload({
        answers: { ...(validLeadPayload().answers as object), state: "GA" },
        state: "FL",
      }),
    );

    const lead = repository.rows[0]!;
    expect(lead.stateSelected).toBe("GA");
    expect(lead.stateFromZip).toBe("FL");
  });

  /* The producer does not retry, but proxies and operators replaying a webhook
     do. A replay must not create a second lead, and must not error — a retry
     cannot fix a duplicate, it can only make another one. */
  it("returns 200 with the original id when the same submission arrives twice", async () => {
    const first = await post(validLeadPayload());
    const second = await post(validLeadPayload());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, id: first.body.id, duplicate: true });
    expect(repository.rows).toHaveLength(1);
  });

  /* One browser session can legitimately submit twice. Deduplicating on the
     session alone would silently drop the second, real lead. */
  it("treats a second completion from the same session as a new lead", async () => {
    await post(validLeadPayload());
    const second = await post(
      validLeadPayload({
        audit: {
          ...(validLeadPayload().audit as object),
          formCompletedAt: "2026-01-15T10:30:00.000Z",
        },
      }),
    );

    expect(second.status).toBe(201);
    expect(repository.rows).toHaveLength(2);
  });

  it("accepts a payload where every nullable field is null", async () => {
    const response = await post(minimalLeadPayload());

    expect(response.status).toBe(201);
    const lead = repository.rows[0]!;
    expect(lead.stateFromZip).toBeNull();
    expect(lead.consent.ipAddress).toBeNull();
    expect(lead.attribution.formStartedAt).toBeNull();
    expect(lead.attribution.utmSource).toBeNull();
  });

  /* Forward compatibility: the producer gaining a tenth answer must not become
     a 422 and a lost lead here. */
  it("accepts unknown extra keys and preserves them in the stored raw payload", async () => {
    const response = await post(
      validLeadPayload({ experimentBucket: "b", answers: { ...(validLeadPayload().answers as object), creditBand: "good" } }),
    );

    expect(response.status).toBe(201);
    const raw = repository.rows[0]!.rawPayload as Record<string, unknown>;
    expect(raw.experimentBucket).toBe("b");
    expect((raw.answers as Record<string, unknown>).creditBand).toBe("good");
  });

  it("stores the consent text verbatim, never truncated or normalised", async () => {
    const payload = validLeadPayload();
    await post(payload);

    const sent = (payload.consent as { text: string }).text;
    expect(repository.rows[0]!.consent.text).toBe(sent);
    expect(repository.rows[0]!.consent.version).toBe("2026-01-v1");
  });

  it("rejects a missing or wrong signature", async () => {
    await expect(request(app).post(INTAKE).send(validLeadPayload())).resolves.toMatchObject({
      status: 401,
    });

    await expect(
      request(app)
        .post(INTAKE)
        .set("x-roadcover-signature", "wrong-secret-same-length-xx")
        .send(validLeadPayload()),
    ).resolves.toMatchObject({ status: 401 });

    expect(repository.rows).toHaveLength(0);
  });

  it("returns 422 with field-keyed messages for a shape violation", async () => {
    const response = await post({});

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("validation_failed");
    expect(Object.keys(response.body.error.details.fieldErrors).length).toBeGreaterThan(0);
    expect(repository.rows).toHaveLength(0);
  });

  it("returns 422 for an invalid answer rather than storing a broken lead", async () => {
    const base = validLeadPayload().answers as object;

    const badPhone = await post(
      validLeadPayload({ answers: { ...base, phone: "(305) 555-014" } }),
    );
    expect(badPhone.status).toBe(422);
    expect(badPhone.body.error.details.fieldErrors).toHaveProperty("answers.phone");

    const badAge = await post(validLeadPayload({ answers: { ...base, age: "9" } }));
    expect(badAge.status).toBe(422);
    expect(badAge.body.error.details.fieldErrors).toHaveProperty("answers.age");

    const badZip = await post(validLeadPayload({ answers: { ...base, zip: "331" } }));
    expect(badZip.status).toBe(422);

    expect(repository.rows).toHaveLength(0);
  });

  it("returns 400, not 500, for malformed JSON", async () => {
    const response = await request(app)
      .post(INTAKE)
      .set("x-roadcover-signature", WEBHOOK_SECRET)
      .set("content-type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("malformed_body");
  });

  /* Mass assignment: a caller must not be able to set columns the contract does
     not expose, such as arriving pre-sold to skip the operator's queue. */
  it("ignores a client-supplied status and id", async () => {
    const response = await post(validLeadPayload({ status: "sold", id: 4242 }));

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.status).toBe("new");
    expect(repository.rows[0]!.id).not.toBe(4242);
  });

  /* The producer treats any non-2xx as failure and shows the consumer a retry.
     A storage outage is the one case where retrying is the right advice. */
  it("returns 503 when storage is unavailable", async () => {
    repository.failNext = new Error("connection terminated");
    const response = await post(validLeadPayload());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("storage_unavailable");
  });

  it("does not accept the admin API key in place of the webhook signature", async () => {
    const response = await request(app)
      .post(INTAKE)
      .set("x-api-key", API_KEY)
      .send(validLeadPayload());

    expect(response.status).toBe(401);
  });
});

describe("operator reads", () => {
  let repository: ReturnType<typeof createFakeLeadRepository>;
  let app: express.Express;

  beforeEach(async () => {
    repository = createFakeLeadRepository();
    app = createApp({ leadService: createLeadService(repository) });
    await request(app)
      .post(INTAKE)
      .set("x-roadcover-signature", WEBHOOK_SECRET)
      .send(validLeadPayload());
  });

  const authed = (path: string) => request(app).get(path).set("x-api-key", API_KEY);

  it("lists leads for a caller holding the admin API key", async () => {
    const response = await authed(INTAKE);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination).toMatchObject({ total: 1, limit: 25, offset: 0 });
  });

  it("resolves /stats as a route rather than as a lead id", async () => {
    const response = await authed(`${INTAKE}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.data.byStatus.new).toBe(1);
  });

  it("returns the consent record and attribution on the detail view", async () => {
    const response = await authed(`${INTAKE}/1`);

    expect(response.status).toBe(200);
    expect(response.body.data.consent.version).toBe("2026-01-v1");
    expect(response.body.data.attribution.utmCampaign).toBe("auto-fl");
    expect(response.body.data.rawPayload).toBeTruthy();
  });

  it("refuses operator reads to a caller holding only the webhook secret", async () => {
    const response = await request(app)
      .get(INTAKE)
      .set("x-roadcover-signature", WEBHOOK_SECRET);

    expect(response.status).toBe(401);
  });

  it("updates a status and rejects one outside the list", async () => {
    const ok = await request(app)
      .patch(`${INTAKE}/1/status`)
      .set("x-api-key", API_KEY)
      .send({ status: "contacted" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("contacted");

    const bad = await request(app)
      .patch(`${INTAKE}/1/status`)
      .set("x-api-key", API_KEY)
      .send({ status: "archived" });
    expect(bad.status).toBe(422);
  });

  it("returns 404 for a lead that does not exist", async () => {
    const response = await authed(`${INTAKE}/999`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});
