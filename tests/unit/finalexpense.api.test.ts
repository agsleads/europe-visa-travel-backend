import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { ageOn, parseCalendarDate } from "@/domain/finalexpense.schema";
import {
  createFinalExpenseService,
  type FinalExpenseService,
} from "@/services/finalexpense.service";
import {
  answersWith,
  createFakeFinalExpenseRepository,
  validFinalExpensePayload,
} from "../helpers/fakeFinalExpenseRepository";

const API_KEY = process.env.API_KEY as string;
const FE_SECRET = process.env.FINALEXPENSE_WEBHOOK_SECRET as string;
const ROADCOVER_SECRET = process.env.ROADCOVER_WEBHOOK_SECRET as string;

const INTAKE = "/api/v1/finalexpense/leads";

/**
 * Full HTTP tests through the real app -- real middleware, real routing, real
 * error handler -- with only the repository faked.
 */
describe("POST /api/v1/finalexpense/leads", () => {
  let repository: ReturnType<typeof createFakeFinalExpenseRepository>;
  let service: FinalExpenseService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeFinalExpenseRepository();
    service = createFinalExpenseService(repository);
    app = createApp({ finalExpenseService: service });
  });

  const post = (body: unknown) =>
    request(app).post(INTAKE).set("x-finalexpense-signature", FE_SECRET).send(body as object);

  it("records a valid lead and returns 201 with its id", async () => {
    const response = await post(validFinalExpensePayload());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { id: 1, duplicate: false } });
    expect(response.headers.location).toBe(`${INTAKE}/1`);
    expect(repository.rows).toHaveLength(1);
  });

  it("derives the age and the normalised phone and email", async () => {
    await post(validFinalExpensePayload());

    const lead = repository.rows[0]!;
    // Born 1955-11-03, submitted 2026-09-20: the birthday has not come yet.
    expect(lead.age).toBe(70);
    expect(lead.dateOfBirth).toBe("1955-11-03");
    expect(lead.phoneRaw).toBe("(307) 555-0142");
    expect(lead.phoneE164).toBe("+13075550142");
    // The schema lower-cases the address; the normalised form is what repeats match on.
    expect(lead.email).toBe("margaret.oconnor@example.com");
    expect(lead.emailNormalised).toBe("margaret.oconnor@example.com");
    expect(lead.coverageAmount).toBe(15000);
    expect(lead.source).toBe("finalexpensecoverage.us");
  });

  /* A visitor who retries after a network error re-sends the same submission id.
     That must not create a second lead, and must not error -- a retry cannot fix
     a duplicate, it can only make another one. */
  it("returns 200 with the original id when the same submission arrives twice", async () => {
    const first = await post(validFinalExpensePayload());
    const second = await post(validFinalExpensePayload());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ data: { id: first.body.data.id, duplicate: true } });
    expect(repository.rows).toHaveLength(1);
  });

  it("treats a new submission id from the same person as a new lead, flagged as a repeat", async () => {
    await post(validFinalExpensePayload());
    const second = await post(validFinalExpensePayload({ submissionId: "a-different-submission-id" }));

    expect(second.status).toBe(201);
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows[1]!.isRepeat).toBe(true);
  });

  it("accepts a coverage amount sent as a digit string", async () => {
    const response = await post(
      validFinalExpensePayload({ answers: answersWith({ coverageAmount: "25000" }) }),
    );

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.coverageAmount).toBe(25000);
  });

  it("accepts a payload with no audit block at all", async () => {
    const payload = validFinalExpensePayload();
    delete payload.audit;
    const response = await post(payload);

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.consent.ipAddress).toBeNull();
    expect(repository.rows[0]!.consent.userAgent).toBeNull();
  });

  /* Forward compatibility: the site gaining a new answer must not become a 422
     and a lost lead here. */
  it("accepts unknown extra keys and preserves them in the stored raw payload", async () => {
    const response = await post(
      validFinalExpensePayload({ experiment: "b", answers: answersWith({ beneficiary: "spouse" }) }),
    );

    expect(response.status).toBe(201);
    const raw = repository.rows[0]!.rawPayload as Record<string, unknown>;
    expect(raw.experiment).toBe("b");
    expect((raw.answers as Record<string, unknown>).beneficiary).toBe("spouse");
  });

  it("stores the consent text verbatim, never truncated or normalised", async () => {
    const payload = validFinalExpensePayload();
    await post(payload);

    expect(repository.rows[0]!.consent.text).toBe((payload.consent as { text: string }).text);
    expect(repository.rows[0]!.consent.version).toBe("fec-tcpa-2026-09-18");
  });

  it("rejects a missing or wrong signature", async () => {
    const missing = await request(app).post(INTAKE).send(validFinalExpensePayload());
    expect(missing.status).toBe(401);

    const wrong = await request(app)
      .post(INTAKE)
      .set("x-finalexpense-signature", "wrong-secret-of-a-plausible-length")
      .send(validFinalExpensePayload());
    expect(wrong.status).toBe(401);

    expect(repository.rows).toHaveLength(0);
  });

  /* Each credential opens only its own door. A leaked Road Cover secret or admin
     key must not become a way to write Final Expense leads. */
  it("does not accept the admin API key or the Road Cover secret in place of its own", async () => {
    const withApiKey = await request(app)
      .post(INTAKE)
      .set("x-api-key", API_KEY)
      .send(validFinalExpensePayload());
    expect(withApiKey.status).toBe(401);

    const withRoadCover = await request(app)
      .post(INTAKE)
      .set("x-finalexpense-signature", ROADCOVER_SECRET)
      .send(validFinalExpensePayload());
    expect(withRoadCover.status).toBe(401);
  });

  it("returns 422 with field-keyed messages for an empty body", async () => {
    const response = await post({});

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("validation_failed");
    expect(response.body.error.details.fieldErrors).toHaveProperty("submissionId");
    expect(repository.rows).toHaveLength(0);
  });

  it("returns 422 for an invalid answer rather than storing a broken lead", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ phone: "(307) 555-014" }, "answers.phone"],
      [{ phone: "(107) 555-0142" }, "answers.phone"], // area codes never start with 1
      [{ email: "not-an-email" }, "answers.email"],
      [{ zip: "8200" }, "answers.zip"],
      [{ firstName: "   " }, "answers.firstName"],
      [{ dateOfBirth: "11/03/1955" }, "answers.dateOfBirth"],
      [{ dateOfBirth: "1955-02-30" }, "answers.dateOfBirth"], // not a real date
      [{ coverageAmount: 500 }, "answers.coverageAmount"],
      [{ coverageAmount: 15000.5 }, "answers.coverageAmount"],
      [{ coverageAmount: "" }, "answers.coverageAmount"],
      [{ coverageAmount: "12,000" }, "answers.coverageAmount"],
    ];

    for (const [change, field] of cases) {
      const response = await post(validFinalExpensePayload({ answers: answersWith(change) }));
      expect(response.status, JSON.stringify(change)).toBe(422);
      expect(response.body.error.details.fieldErrors, JSON.stringify(change)).toHaveProperty(field);
    }

    expect(repository.rows).toHaveLength(0);
  });

  it("rejects an implausible age measured at the time of submission", async () => {
    const tooYoung = await post(
      validFinalExpensePayload({ answers: answersWith({ dateOfBirth: "2015-01-01" }) }),
    );
    expect(tooYoung.status).toBe(422);
    expect(tooYoung.body.error.details.fieldErrors).toHaveProperty("answers.dateOfBirth");

    const inFuture = await post(
      validFinalExpensePayload({ answers: answersWith({ dateOfBirth: "2030-01-01" }) }),
    );
    expect(inFuture.status).toBe(422);
  });

  /* The age check reads two fields. A malformed timestamp must be reported as
     the 422 it is, not crash the cross-field check into a 500. */
  it("returns 422, not 500, for a malformed receivedAt alongside a valid birthday", async () => {
    const response = await post(validFinalExpensePayload({ receivedAt: "yesterday-ish" }));

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toHaveProperty("receivedAt");
  });

  it("returns 400, not 500, for malformed JSON", async () => {
    const response = await request(app)
      .post(INTAKE)
      .set("x-finalexpense-signature", FE_SECRET)
      .set("content-type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("malformed_body");
  });

  /* Mass assignment: a caller must not be able to set columns the contract does
     not expose, such as its own id or a precomputed age. */
  it("ignores a client-supplied id and age", async () => {
    const response = await post(validFinalExpensePayload({ id: 4242, age: 21 }));

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.id).not.toBe(4242);
    expect(repository.rows[0]!.age).toBe(70);
  });

  /* The site shows the visitor a retry on any non-2xx. A storage outage is the
     one case where retrying is the right advice. */
  it("returns 503 when storage is unavailable", async () => {
    repository.failNext = new Error("connection terminated");
    const response = await post(validFinalExpensePayload());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("storage_unavailable");
  });
});

describe("Final Expense operator reads", () => {
  let repository: ReturnType<typeof createFakeFinalExpenseRepository>;
  let app: express.Express;

  beforeEach(async () => {
    repository = createFakeFinalExpenseRepository();
    app = createApp({ finalExpenseService: createFinalExpenseService(repository) });
    await request(app)
      .post(INTAKE)
      .set("x-finalexpense-signature", FE_SECRET)
      .send(validFinalExpensePayload());
  });

  const authed = (path: string) => request(app).get(path).set("x-api-key", API_KEY);

  it("lists leads for a caller holding the admin API key, without the date of birth", async () => {
    const response = await authed(INTAKE);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ firstName: "Margaret", age: 70, coverageAmount: 15000 });
    expect(response.body.data[0]).not.toHaveProperty("dateOfBirth");
    expect(response.body.pagination).toMatchObject({ total: 1, limit: 25, offset: 0, hasMore: false });
  });

  it("searches by name and by phone digits", async () => {
    expect((await authed(`${INTAKE}?q=oconnor`)).body.data).toHaveLength(1);
    expect((await authed(`${INTAKE}?q=3075550142`)).body.data).toHaveLength(1);
    expect((await authed(`${INTAKE}?q=nobody`)).body.data).toHaveLength(0);
  });

  it("resolves /stats as a route rather than as a lead id", async () => {
    const response = await authed(`${INTAKE}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 1 });
  });

  it("returns the birthday, consent record and raw payload on the detail view", async () => {
    const response = await authed(`${INTAKE}/1`);

    expect(response.status).toBe(200);
    expect(response.body.data.dateOfBirth).toBe("1955-11-03");
    expect(response.body.data.consent.version).toBe("fec-tcpa-2026-09-18");
    expect(response.body.data.consent.ipAddress).toBe("198.51.100.23");
    expect(response.body.data.rawPayload).toBeTruthy();
  });

  it("refuses operator reads to a caller holding only the intake secret", async () => {
    const response = await request(app).get(INTAKE).set("x-finalexpense-signature", FE_SECRET);
    expect(response.status).toBe(401);
  });

  it("returns 404 for a lead that does not exist, and 422 for a non-numeric id", async () => {
    const missing = await authed(`${INTAKE}/999`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    const junk = await authed(`${INTAKE}/abc`);
    expect(junk.status).toBe(422);
  });

  it("rejects an unknown or out-of-range query parameter value", async () => {
    expect((await authed(`${INTAKE}?limit=0`)).status).toBe(422);
    expect((await authed(`${INTAKE}?limit=500`)).status).toBe(422);
  });
});

describe("age arithmetic", () => {
  const dob = parseCalendarDate("1960-03-15")!;

  it("counts a birthday only once it has arrived", () => {
    expect(ageOn(dob, new Date("2026-03-14T23:59:59Z"))).toBe(65);
    expect(ageOn(dob, new Date("2026-03-15T00:00:00Z"))).toBe(66);
  });

  it("rejects impossible calendar dates", () => {
    expect(parseCalendarDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(parseCalendarDate("2024-02-29")).not.toBeNull();
    expect(parseCalendarDate("1960-13-01")).toBeNull();
  });
});
