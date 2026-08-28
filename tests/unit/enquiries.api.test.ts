import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createEnquiryService, type EnquiryService } from "@/services/enquiry.service";
import { createFakeRepository, validEnquiryPayload } from "../helpers/fakeRepository";

const API_KEY = process.env.API_KEY as string;

/**
 * Full HTTP tests through the real app — real middleware, real routing, real
 * error handler — with only the repository faked. Mocking the router or the
 * service would leave exactly the wiring these tests exist to prove untested.
 */
describe("POST /api/v1/enquiries", () => {
  let repository: ReturnType<typeof createFakeRepository>;
  let service: EnquiryService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeRepository();
    service = createEnquiryService(repository);
    app = createApp({ enquiryService: service });
  });

  const post = (body: unknown) =>
    request(app).post("/api/v1/enquiries").set("x-api-key", API_KEY).send(body as object);

  it("creates an enquiry and returns 201 with a reference", async () => {
    const response = await post(validEnquiryPayload());

    expect(response.status).toBe(201);
    expect(response.body.data.reference).toMatch(/^EVC-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(response.headers.location).toBe(`/api/v1/enquiries/${response.body.data.id}`);
    expect(repository.rows).toHaveLength(1);
  });

  /* The caller already has the payload; echoing it back widens the exposure of
     personal data for no benefit. */
  it("returns only the identifiers, not the submitted personal data", async () => {
    const response = await post(validEnquiryPayload());
    expect(Object.keys(response.body.data).sort()).toEqual(["createdAt", "id", "reference"]);
  });

  it("returns 422 with field-keyed messages the frontend can map onto its inputs", async () => {
    const response = await post(validEnquiryPayload({ email: "nope", message: "short" }));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("validation_failed");
    expect(response.body.error.details.fieldErrors).toMatchObject({
      email: expect.any(String),
      message: expect.any(String),
    });
    expect(repository.rows).toHaveLength(0);
  });

  it("rejects a submission without consent", async () => {
    const response = await post(validEnquiryPayload({ consent: false }));
    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toHaveProperty("consent");
  });

  /* Mass assignment: a client must not be able to set columns the API does not
     expose, such as arriving pre-closed to skip the operator's inbox. */
  it("ignores client-supplied status and id", async () => {
    const response = await post(validEnquiryPayload({ status: "closed", id: 4242 }));

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.status).toBe("new");
    expect(repository.rows[0]!.id).not.toBe(4242);
  });

  it("rejects a missing or wrong API key", async () => {
    await expect(
      request(app).post("/api/v1/enquiries").send(validEnquiryPayload()),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      request(app)
        .post("/api/v1/enquiries")
        .set("x-api-key", "wrong-key-but-the-same-length")
        .send(validEnquiryPayload()),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects a body over the size cap before it is buffered into memory", async () => {
    const response = await post(validEnquiryPayload({ message: "x".repeat(200_000) }));
    expect(response.status).toBe(413);
  });

  it("returns a structured error, not an Express HTML page, for malformed JSON", async () => {
    const response = await request(app)
      .post("/api/v1/enquiries")
      .set("x-api-key", API_KEY)
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error).toBeDefined();
    expect(response.body.error.requestId).toBeTruthy();
  });

  it("maps a storage failure to 503 without leaking the driver message", async () => {
    repository.failNext = new Error('relation "enquiries" does not exist');
    const response = await post(validEnquiryPayload());

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("relation");
  });

  it("echoes a caller-supplied request id so logs correlate across services", async () => {
    const response = await request(app)
      .post("/api/v1/enquiries")
      .set("x-api-key", API_KEY)
      .set("x-request-id", "next-abc-123")
      .send(validEnquiryPayload());

    expect(response.headers["x-request-id"]).toBe("next-abc-123");
  });

  /* The header reaches a response header and every log line, so a forged value
     must be replaced rather than reflected. */
  it("replaces a malformed inbound request id rather than reflecting it", async () => {
    const response = await request(app)
      .post("/api/v1/enquiries")
      .set("x-api-key", API_KEY)
      .set("x-request-id", "bad id with spaces")
      .send(validEnquiryPayload());

    expect(response.headers["x-request-id"]).not.toBe("bad id with spaces");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("read endpoints", () => {
  let repository: ReturnType<typeof createFakeRepository>;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeRepository();
    app = createApp({ enquiryService: createEnquiryService(repository) });
  });

  const auth = (r: request.Test) => r.set("x-api-key", API_KEY);

  it("lists enquiries newest-first with pagination", async () => {
    for (let i = 0; i < 3; i++) {
      await auth(request(app).post("/api/v1/enquiries")).send(
        validEnquiryPayload({ email: `p${i}@example.com` }),
      );
    }

    const response = await auth(request(app).get("/api/v1/enquiries?limit=2"));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.pagination).toMatchObject({ total: 3, hasMore: true });
  });

  it("never exposes the client hash or user agent", async () => {
    await auth(request(app).post("/api/v1/enquiries")).send(validEnquiryPayload());
    const response = await auth(request(app).get("/api/v1/enquiries"));

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain("clientHash");
    expect(serialised).not.toContain("userAgent");
  });

  it("404s an unknown id and 422s a non-numeric one", async () => {
    await expect(auth(request(app).get("/api/v1/enquiries/999"))).resolves.toMatchObject({
      status: 404,
    });
    await expect(auth(request(app).get("/api/v1/enquiries/abc"))).resolves.toMatchObject({
      status: 422,
    });
  });

  it("updates a status and rejects one outside the allowed set", async () => {
    const created = await auth(request(app).post("/api/v1/enquiries")).send(validEnquiryPayload());
    const id = created.body.data.id;

    await expect(
      auth(request(app).patch(`/api/v1/enquiries/${id}/status`)).send({ status: "responded" }),
    ).resolves.toMatchObject({ status: 200, body: { data: { status: "responded" } } });

    await expect(
      auth(request(app).patch(`/api/v1/enquiries/${id}/status`)).send({ status: "archived" }),
    ).resolves.toMatchObject({ status: 422 });
  });

  it("requires the API key on every read endpoint", async () => {
    for (const path of ["/api/v1/enquiries", "/api/v1/enquiries/1"]) {
      await expect(request(app).get(path)).resolves.toMatchObject({ status: 401 });
    }
  });
});

describe("infrastructure", () => {
  const build = () => createApp({ enquiryService: createEnquiryService(createFakeRepository()) });

  it("reports liveness without touching the database", async () => {
    const response = await request(build()).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("returns a JSON 404 for an unknown route", async () => {
    const response = await request(build()).get("/api/v1/nope");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });

  it("does not advertise the server implementation", async () => {
    const response = await request(build()).get("/health/live");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});
