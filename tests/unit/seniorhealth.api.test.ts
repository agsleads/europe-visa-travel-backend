import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import {
  createSeniorHealthService,
  type SeniorHealthService,
} from "@/services/seniorhealth.service";
import {
  createFakeSeniorHealthRepository,
  seniorHealthAnswersWith,
  validSeniorHealthPayload,
} from "../helpers/fakeSeniorHealthRepository";

const API_KEY = process.env.API_KEY as string;
const SHB_SECRET = process.env.SENIORHEALTH_WEBHOOK_SECRET as string;
const FE_SECRET = process.env.FINALEXPENSE_WEBHOOK_SECRET as string;

const INTAKE = "/api/v1/seniorhealth/leads";

/**
 * Full HTTP tests through the real app -- real middleware, real routing, real
 * error handler -- with only the repository faked.
 */
describe("POST /api/v1/seniorhealth/leads", () => {
  let repository: ReturnType<typeof createFakeSeniorHealthRepository>;
  let service: SeniorHealthService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeSeniorHealthRepository();
    service = createSeniorHealthService(repository);
    app = createApp({ seniorHealthService: service });
  });

  const post = (body: unknown) =>
    request(app).post(INTAKE).set("x-seniorhealth-signature", SHB_SECRET).send(body as object);

  it("records a valid lead and returns 201 with its id", async () => {
    const response = await post(validSeniorHealthPayload());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { id: 1, duplicate: false } });
    expect(response.headers.location).toBe(`${INTAKE}/1`);
    expect(repository.rows).toHaveLength(1);
  });

  it("normalises the phone number and upper-cases the state", async () => {
    await post(
      validSeniorHealthPayload({
        answers: seniorHealthAnswersWith({ phone: "307-555-0142", state: "wy" }),
      }),
    );

    const lead = repository.rows[0]!;
    expect(lead.phoneE164).toBe("+13075550142");
    // The raw form is kept as typed: the consent record refers to it.
    expect(lead.phoneRaw).toBe("307-555-0142");
    expect(lead.state).toBe("WY");
  });

  it("stores the consent record verbatim", async () => {
    const payload = validSeniorHealthPayload();
    await post(payload);

    const consent = repository.rows[0]!.consent;
    const sent = (payload as { consent: { text: string; version: string } }).consent;
    expect(consent.text).toBe(sent.text);
    expect(consent.version).toBe(sent.version);
    expect(consent.ipAddress).toBe("198.51.100.23");
  });

  it("keeps the original body in raw_payload, including unknown keys", async () => {
    await post(validSeniorHealthPayload({ utmCampaign: "aep-2026" }));

    expect(repository.rows[0]!.rawPayload).toMatchObject({ utmCampaign: "aep-2026" });
  });

  it("answers a retry of the same submission with 200 and writes nothing new", async () => {
    const payload = validSeniorHealthPayload();
    await post(payload);
    const second = await post(payload);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ data: { id: 1, duplicate: true } });
    expect(repository.rows).toHaveLength(1);
  });

  it("treats the same submission id from another source as a different lead", async () => {
    await post(validSeniorHealthPayload());
    const other = await post(
      validSeniorHealthPayload({ source: "seniorhealthbenefits.net/contact" }),
    );

    expect(other.status).toBe(201);
    expect(repository.rows).toHaveLength(2);
  });

  it("flags a second lead from the same phone number as a repeat", async () => {
    await post(validSeniorHealthPayload());
    await post(validSeniorHealthPayload({ submissionId: "b1d9f0c4-2a77-4e5b-9c31-8a6d2f0e4b55" }));

    expect(repository.rows[1]!.isRepeat).toBe(true);
  });

  it.each([
    ["a missing first name", { firstName: "" }],
    ["a phone number that is not ten digits", { phone: "(307) 555-014" }],
    ["a ZIP that is not five digits", { zip: "826" }],
    ["a state that is not a real code", { state: "XX" }],
  ])("rejects %s with 422", async (_label, change) => {
    const response = await post(
      validSeniorHealthPayload({ answers: seniorHealthAnswersWith(change) }),
    );

    expect(response.status).toBe(422);
    expect(repository.rows).toHaveLength(0);
  });

  it("rejects a submission with no consent text", async () => {
    const response = await post(
      validSeniorHealthPayload({
        consent: { text: "", version: "shb-tcpa-2026-09-23", timestamp: "2026-09-23T15:20:41.000Z" },
      }),
    );

    expect(response.status).toBe(422);
    expect(repository.rows).toHaveLength(0);
  });

  it("answers 503, not 500, when the lead could not be stored", async () => {
    repository.failNext = new Error("connection terminated");

    const response = await post(validSeniorHealthPayload());

    // The site retries on a 5xx; a 503 says the retry is worth making.
    expect(response.status).toBe(503);
  });

  it("rejects intake with a missing or wrong signature", async () => {
    const missing = await request(app).post(INTAKE).send(validSeniorHealthPayload());
    expect(missing.status).toBe(401);

    // Another producer's secret must not open this intake.
    const wrong = await request(app)
      .post(INTAKE)
      .set("x-seniorhealth-signature", FE_SECRET)
      .send(validSeniorHealthPayload());
    expect(wrong.status).toBe(401);

    expect(repository.rows).toHaveLength(0);
  });

  it("does not accept the admin API key in place of the webhook secret", async () => {
    const response = await request(app)
      .post(INTAKE)
      .set("x-api-key", API_KEY)
      .send(validSeniorHealthPayload());

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/seniorhealth/leads", () => {
  let repository: ReturnType<typeof createFakeSeniorHealthRepository>;
  let app: express.Express;

  beforeEach(async () => {
    repository = createFakeSeniorHealthRepository();
    app = createApp({ seniorHealthService: createSeniorHealthService(repository) });

    await request(app)
      .post(INTAKE)
      .set("x-seniorhealth-signature", SHB_SECRET)
      .send(validSeniorHealthPayload());
    await request(app)
      .post(INTAKE)
      .set("x-seniorhealth-signature", SHB_SECRET)
      .send(
        validSeniorHealthPayload({
          submissionId: "c7e2b910-44af-4c68-86d1-3b90f2a7e551",
          answers: seniorHealthAnswersWith({
            firstName: "Arthur",
            lastName: "Reyes",
            phone: "(305) 555-0188",
            zip: "33101",
            state: "FL",
          }),
        }),
      );
  });

  const get = (path: string) => request(app).get(path).set("x-api-key", API_KEY);

  it("returns the leads newest first with pagination", async () => {
    const response = await get(INTAKE);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].firstName).toBe("Arthur");
    expect(response.body.pagination).toMatchObject({ total: 2, limit: 25, offset: 0 });
  });

  it("does not publish the dedupe key or the raw payload in the list", async () => {
    const response = await get(INTAKE);

    expect(response.body.data[0]).not.toHaveProperty("dedupeKey");
    expect(response.body.data[0]).not.toHaveProperty("rawPayload");
  });

  it("filters by state", async () => {
    const response = await get(`${INTAKE}?state=FL`);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].lastName).toBe("Reyes");
  });

  it("searches by name and by unformatted phone digits", async () => {
    expect((await get(`${INTAKE}?q=Dorothy`)).body.data).toHaveLength(1);
    expect((await get(`${INTAKE}?q=3055550188`)).body.data).toHaveLength(1);
  });

  it("returns the consent record and raw payload on the detail view", async () => {
    const response = await get(`${INTAKE}/1`);

    expect(response.status).toBe(200);
    expect(response.body.data.consent.version).toBe("shb-tcpa-2026-09-23");
    expect(response.body.data).toHaveProperty("rawPayload");
  });

  it("answers 404 for a lead that does not exist", async () => {
    expect((await get(`${INTAKE}/999`)).status).toBe(404);
  });

  it("rejects reads without the API key, including with the webhook secret", async () => {
    expect((await request(app).get(INTAKE)).status).toBe(401);
    expect(
      (await request(app).get(INTAKE).set("x-seniorhealth-signature", SHB_SECRET)).status,
    ).toBe(401);
  });

  it("resolves /stats as the counters, not as a lead id", async () => {
    const response = await get(`${INTAKE}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 2 });
  });
});
