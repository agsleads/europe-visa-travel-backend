import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createEnquiryService } from "@/services/enquiry.service";
import {
  createFakeCrmRepository,
  createFakeRepository,
  fakeServiceDeps,
  validEnquiryPayload,
} from "../helpers/fakeRepository";

const API_KEY = process.env.API_KEY as string;

/**
 * The CRM surface: lead fields, assignment, contact logging, notes and
 * follow-ups. Driven through the real app with only the repositories faked,
 * so routing, validation and the activity rules are all exercised together.
 */
describe("CRM endpoints", () => {
  let repository: ReturnType<typeof createFakeRepository>;
  let crm: ReturnType<typeof createFakeCrmRepository>;
  let app: express.Express;

  const SARAH = { id: "usr_3", name: "Sarah Chen" };
  const MARCUS = { id: "usr_4", name: "Marcus Johnson" };

  beforeEach(() => {
    repository = createFakeRepository();
    crm = createFakeCrmRepository();
    app = createApp({ enquiryService: createEnquiryService(repository, fakeServiceDeps(crm)) });
  });

  const as = (req: request.Test) =>
    req.set("x-api-key", API_KEY).set("x-actor-id", "usr_1").set("x-actor-name", "Alex Morgan");

  async function seed(count = 1): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const response = await as(request(app).post("/api/v1/enquiries")).send(
        validEnquiryPayload({ email: `person${i}@example.com` }),
      );
      ids.push(response.body.data.id);
    }
    return ids;
  }

  it("presents the lead fields on every enquiry", async () => {
    const [id] = await seed();
    const response = await as(request(app).get(`/api/v1/enquiries/${id}`));

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "new",
      priority: "medium",
      assignedTo: null,
      lastContactAt: null,
      nextFollowUpAt: null,
    });
  });

  describe("PATCH /:id", () => {
    it("changes status and priority, recording one attributed activity per change", async () => {
      const [id] = await seed();

      const response = await as(request(app).patch(`/api/v1/enquiries/${id}`)).send({
        status: "qualified",
        priority: "urgent",
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ status: "qualified", priority: "urgent" });
      expect(crm.activities.map((a) => [a.type, a.description, a.actor.name])).toEqual([
        ["status_changed", "Status changed from New to Qualified", "Alex Morgan"],
        ["priority_changed", "Priority changed from Medium to Urgent", "Alex Morgan"],
      ]);
    });

    it("records nothing when the value does not change", async () => {
      const [id] = await seed();
      await as(request(app).patch(`/api/v1/enquiries/${id}`)).send({ priority: "medium" });
      expect(crm.activities).toEqual([]);
    });

    it("rejects an empty patch and an unknown status", async () => {
      const [id] = await seed();
      await expect(as(request(app).patch(`/api/v1/enquiries/${id}`)).send({})).resolves.toMatchObject({
        status: 422,
      });
      await expect(
        as(request(app).patch(`/api/v1/enquiries/${id}`)).send({ status: "closed" }),
      ).resolves.toMatchObject({ status: 422 });
    });

    it("404s an unknown enquiry", async () => {
      await expect(
        as(request(app).patch("/api/v1/enquiries/999")).send({ status: "lost" }),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe("assignment", () => {
    it("assigns, reassigns and unassigns, describing each move", async () => {
      const [id] = await seed();
      const assign = (assignee: unknown) =>
        as(request(app).put(`/api/v1/enquiries/${id}/assignee`)).send({ assignee });

      await expect(assign(SARAH)).resolves.toMatchObject({
        status: 200,
        body: { data: { assignedTo: SARAH } },
      });
      await assign(MARCUS);
      await expect(assign(null)).resolves.toMatchObject({ body: { data: { assignedTo: null } } });

      expect(crm.activities.map((a) => a.description)).toEqual([
        "Assigned to Sarah Chen",
        "Reassigned from Sarah Chen to Marcus Johnson",
        "Unassigned from Marcus Johnson",
      ]);
    });

    it("treats assigning to the current owner as a no-op", async () => {
      const [id] = await seed();
      await as(request(app).put(`/api/v1/enquiries/${id}/assignee`)).send({ assignee: SARAH });
      await as(request(app).put(`/api/v1/enquiries/${id}/assignee`)).send({ assignee: SARAH });
      expect(crm.activities).toHaveLength(1);
    });

    it("requires both halves of an assignee", async () => {
      const [id] = await seed();
      const response = await as(request(app).put(`/api/v1/enquiries/${id}/assignee`)).send({
        assignee: { id: "usr_3" },
      });
      expect(response.status).toBe(422);
    });

    it("bulk-assigns, reporting changed, unchanged and missing ids", async () => {
      const [a, b, c] = await seed(3);
      await as(request(app).put(`/api/v1/enquiries/${a}/assignee`)).send({ assignee: SARAH });

      const response = await as(request(app).post("/api/v1/enquiries/bulk-assign")).send({
        ids: [a, b, c, 999],
        assignee: SARAH,
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ updated: 2, unchanged: 1, notFound: [999] });
      expect(repository.rows.every((r) => r.assignedTo?.id === "usr_3")).toBe(true);
    });

    it("is matched as its own route, not as an enquiry id", async () => {
      const response = await as(request(app).post("/api/v1/enquiries/bulk-assign")).send({
        ids: [],
        assignee: null,
      });
      // 422 from the bulk schema (empty selection), not 404/405 from `/:id`.
      expect(response.status).toBe(422);
      expect(response.body.error.details.fieldErrors).toHaveProperty("ids");
    });

    it("filters the list by assignee and by the unassigned queue", async () => {
      const [a] = await seed(3);
      await as(request(app).put(`/api/v1/enquiries/${a}/assignee`)).send({ assignee: SARAH });

      const mine = await as(request(app).get("/api/v1/enquiries?assignedTo=usr_3"));
      const queue = await as(request(app).get("/api/v1/enquiries?assignedTo=unassigned"));

      expect(mine.body.pagination.total).toBe(1);
      expect(queue.body.pagination.total).toBe(2);
    });
  });

  it("logs a contact, stamps last contact and rejects an unknown channel", async () => {
    const [id] = await seed();

    const response = await as(request(app).post(`/api/v1/enquiries/${id}/contacts`)).send({ channel: "call" });

    expect(response.status).toBe(201);
    expect(response.body.data.lastContactAt).toEqual(expect.any(String));
    expect(crm.activities.at(-1)).toMatchObject({ type: "call", description: "Call logged" });
    await expect(
      as(request(app).post(`/api/v1/enquiries/${id}/contacts`)).send({ channel: "fax" }),
    ).resolves.toMatchObject({ status: 422 });
  });

  describe("notes", () => {
    it("creates, edits, lists and deletes a note", async () => {
      const [id] = await seed();
      const base = `/api/v1/enquiries/${id}/notes`;

      const created = await as(request(app).post(base)).send({ content: "  Prefers a call after 5pm.  " });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        content: "Prefers a call after 5pm.",
        author: { id: "usr_1", name: "Alex Morgan" },
      });
      const noteId = created.body.data.id;

      await expect(
        as(request(app).patch(`${base}/${noteId}`)).send({ content: "Prefers WhatsApp." }),
      ).resolves.toMatchObject({ status: 200, body: { data: { content: "Prefers WhatsApp." } } });

      expect((await as(request(app).get(base))).body.data).toHaveLength(1);
      await expect(as(request(app).delete(`${base}/${noteId}`))).resolves.toMatchObject({ status: 204 });
      expect((await as(request(app).get(base))).body.data).toEqual([]);
      expect(crm.activities.map((a) => a.type)).toEqual(["note_added"]);
    });

    it("rejects an empty note and 404s a note under the wrong enquiry", async () => {
      const [a, b] = await seed(2);
      await expect(
        as(request(app).post(`/api/v1/enquiries/${a}/notes`)).send({ content: "   " }),
      ).resolves.toMatchObject({ status: 422 });

      const note = await as(request(app).post(`/api/v1/enquiries/${a}/notes`)).send({ content: "Hello" });
      await expect(
        as(request(app).delete(`/api/v1/enquiries/${b}/notes/${note.body.data.id}`)),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  describe("follow-ups", () => {
    it("schedules, completes and deletes a follow-up", async () => {
      const [id] = await seed();
      const base = `/api/v1/enquiries/${id}/follow-ups`;
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();

      const created = await as(request(app).post(base)).send({ title: "Send checklist", dueAt });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ title: "Send checklist", dueAt, completed: false });
      const followUpId = created.body.data.id;

      const done = await as(request(app).patch(`${base}/${followUpId}`)).send({ completed: true });
      expect(done.body.data).toMatchObject({ completed: true, completedAt: expect.any(String) });
      // Re-ticking a done follow-up is not a second completion.
      await as(request(app).patch(`${base}/${followUpId}`)).send({ completed: true });

      expect(crm.activities.map((a) => a.description)).toEqual([
        "Follow-up scheduled: Send checklist",
        "Follow-up completed: Send checklist",
      ]);
      await expect(as(request(app).delete(`${base}/${followUpId}`))).resolves.toMatchObject({ status: 204 });
    });

    it("rejects a follow-up without a valid due date", async () => {
      const [id] = await seed();
      const response = await as(request(app).post(`/api/v1/enquiries/${id}/follow-ups`)).send({
        title: "Call back",
        dueAt: "tomorrow-ish",
      });
      expect(response.status).toBe(422);
      expect(response.body.error.details.fieldErrors).toHaveProperty("dueAt");
    });

    it("lists open follow-ups across enquiries", async () => {
      const [a, b] = await seed(2);
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const later = new Date(Date.now() + 7_200_000).toISOString();
      await as(request(app).post(`/api/v1/enquiries/${b}/follow-ups`)).send({ title: "Later", dueAt: later });
      await as(request(app).post(`/api/v1/enquiries/${a}/follow-ups`)).send({ title: "Soon", dueAt: soon });

      const response = await as(request(app).get("/api/v1/enquiries/follow-ups?open=true"));

      expect(response.status).toBe(200);
      expect(response.body.data.map((f: { title: string }) => f.title)).toEqual(["Soon", "Later"]);
    });
  });

  it("serves activity, stats and facets as fixed routes ahead of /:id", async () => {
    const [id] = await seed();
    await as(request(app).patch(`/api/v1/enquiries/${id}`)).send({ status: "contacted" });

    const timeline = await as(request(app).get(`/api/v1/enquiries/${id}/activity`));
    expect(timeline.body.data[0]).toMatchObject({ type: "status_changed" });

    const recent = await as(request(app).get("/api/v1/enquiries/activity?limit=5"));
    expect(recent.status).toBe(200);

    const stats = await as(request(app).get("/api/v1/enquiries/stats?assignedTo=unassigned"));
    expect(stats.body.data).toMatchObject({ total: 1, unassigned: 1, byStatus: { contacted: 1 } });

    const facets = await as(request(app).get("/api/v1/enquiries/facets"));
    expect(facets.body.data).toEqual({ destinations: ["France"], visaTypes: [expect.any(String)] });
  });

  it("decodes a percent-encoded actor name, so non-Latin names survive the header", async () => {
    const [id] = await seed();
    await request(app)
      .patch(`/api/v1/enquiries/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-actor-id", "usr_7")
      .set("x-actor-name", encodeURIComponent("Zoë 陈"))
      .send({ status: "contacted" });
    expect(crm.activities[0]!.actor).toEqual({ id: "usr_7", name: "Zoë 陈" });
  });

  it("records a write with no actor headers as the system", async () => {
    const [id] = await seed();
    await request(app)
      .patch(`/api/v1/enquiries/${id}`)
      .set("x-api-key", API_KEY)
      .send({ status: "contacted" });
    expect(crm.activities[0]!.actor).toEqual({ id: null, name: null });
  });

  it("requires the API key on every CRM route", async () => {
    const [id] = await seed();
    const routes: [string, string][] = [
      ["get", "/api/v1/enquiries/follow-ups"],
      ["get", "/api/v1/enquiries/activity"],
      ["get", "/api/v1/enquiries/facets"],
      ["post", "/api/v1/enquiries/bulk-assign"],
      ["patch", `/api/v1/enquiries/${id}`],
      ["put", `/api/v1/enquiries/${id}/assignee`],
      ["post", `/api/v1/enquiries/${id}/contacts`],
      ["get", `/api/v1/enquiries/${id}/notes`],
      ["get", `/api/v1/enquiries/${id}/follow-ups`],
    ];
    for (const [method, path] of routes) {
      const response = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
