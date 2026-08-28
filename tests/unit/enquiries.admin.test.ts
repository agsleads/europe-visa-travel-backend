import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createEnquiryService, type EnquiryService } from "@/services/enquiry.service";
import { createFakeRepository, validEnquiryPayload } from "../helpers/fakeRepository";

const API_KEY = process.env.API_KEY as string;

/**
 * The operator-facing endpoints the admin console is built on: the stats
 * aggregate and search on the list. Driven through the real app, with only the
 * repository faked, for the same reason as the rest of the HTTP suite —
 * mocking the router would leave the wiring untested.
 */
describe("admin read endpoints", () => {
  let repository: ReturnType<typeof createFakeRepository>;
  let service: EnquiryService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeRepository();
    service = createEnquiryService(repository);
    app = createApp({ enquiryService: service });
  });

  const authed = (path: string) => request(app).get(path).set("x-api-key", API_KEY);

  /** Creates `count` enquiries through the real POST path. */
  async function seed(overrides: Record<string, unknown>[] = [{}]) {
    for (const override of overrides) {
      await request(app)
        .post("/api/v1/enquiries")
        .set("x-api-key", API_KEY)
        .send(validEnquiryPayload(override));
    }
  }

  describe("GET /api/v1/enquiries/stats", () => {
    /* The route-ordering trap: registered after `/:id`, "stats" is captured as
       an id and the request 422s instead of reaching the handler. This test is
       here specifically to fail if that ordering is ever reversed. */
    it("is matched as its own route, not as an enquiry id", async () => {
      const response = await authed("/api/v1/enquiries/stats");

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty("byStatus");
    });

    it("requires the API key", async () => {
      const response = await request(app).get("/api/v1/enquiries/stats");
      expect(response.status).toBe(401);
    });

    it("reports every status, including those with no rows", async () => {
      await seed([{}, {}]);

      const response = await authed("/api/v1/enquiries/stats");

      expect(response.status).toBe(200);
      expect(response.body.data.total).toBe(2);
      // A dashboard tile for a status with no enquiries must read 0, not vanish.
      expect(response.body.data.byStatus).toEqual({
        new: 2,
        in_progress: 0,
        responded: 0,
        closed: 0,
        spam: 0,
      });
      expect(response.body.data.last7Days).toBe(2);
    });

    it("moves a count between statuses when one is updated", async () => {
      await seed();
      const id = repository.rows[0]!.id;

      await request(app)
        .patch(`/api/v1/enquiries/${id}/status`)
        .set("x-api-key", API_KEY)
        .send({ status: "closed" });

      const response = await authed("/api/v1/enquiries/stats");

      expect(response.body.data.byStatus.new).toBe(0);
      expect(response.body.data.byStatus.closed).toBe(1);
      expect(response.body.data.total).toBe(1);
    });
  });

  describe("GET /api/v1/enquiries?q=", () => {
    beforeEach(async () => {
      await seed([
        { name: "Aisha Rahman", email: "aisha@example.com", destination: "France" },
        { name: "Tom Baker", email: "tom@elsewhere.test", destination: "Italy" },
      ]);
    });

    it("matches on name", async () => {
      const response = await authed("/api/v1/enquiries?q=aisha");

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe("Aisha Rahman");
      // The count is the size of the whole result set, not of the page.
      expect(response.body.pagination.total).toBe(1);
    });

    it("matches on email and destination too", async () => {
      expect((await authed("/api/v1/enquiries?q=elsewhere.test")).body.data).toHaveLength(1);
      expect((await authed("/api/v1/enquiries?q=Italy")).body.data).toHaveLength(1);
    });

    it("is case-insensitive, so a reference can be typed in lower case", async () => {
      const reference = repository.rows[0]!.reference;

      const response = await authed(`/api/v1/enquiries?q=${reference.toLowerCase()}`);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].reference).toBe(reference);
    });

    /* `?q=` is what a browser sends when the search box is submitted empty.
       Treated as a search for the empty string it would still match every row
       — which is the right answer here, but by accident. The schema normalises
       it to "no filter" so the behaviour is intended rather than incidental. */
    it("treats an empty q as no filter", async () => {
      const response = await authed("/api/v1/enquiries?q=");

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it("combines with a status filter rather than replacing it", async () => {
      const id = repository.rows.find((r) => r.name === "Aisha Rahman")!.id;
      await request(app)
        .patch(`/api/v1/enquiries/${id}/status`)
        .set("x-api-key", API_KEY)
        .send({ status: "closed" });

      expect((await authed("/api/v1/enquiries?q=aisha&status=closed")).body.data).toHaveLength(1);
      expect((await authed("/api/v1/enquiries?q=aisha&status=new")).body.data).toHaveLength(0);
    });

    it("rejects an over-long search term rather than passing it to the database", async () => {
      const response = await authed(`/api/v1/enquiries?q=${"x".repeat(101)}`);

      expect(response.status).toBe(422);
      expect(response.body.error.details.fieldErrors).toHaveProperty("q");
    });

    it("returns an empty page, not an error, when nothing matches", async () => {
      const response = await authed("/api/v1/enquiries?q=nobodybythisname");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
      expect(response.body.pagination.hasMore).toBe(false);
    });
  });
});
