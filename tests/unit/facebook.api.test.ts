import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { errorHandler } from "@/api/middleware/errorHandler";
import { META_WEBHOOK_PATH, metaRouter, metaWebhookBody } from "@/api/routes/meta.routes";
import type { GraphForm, GraphLead } from "@/domain/facebook.schema";
import { createFacebookLeadService, mapFacebookLead, NOT_SPECIFIED } from "@/services/facebookLead.service";
import { createMetaClient, MetaGraphError, type MetaClient } from "@/services/meta.client";
import { createEnquiryService } from "@/services/enquiry.service";
import { createFakeRepository, fakeServiceDeps } from "../helpers/fakeRepository";

const API_KEY = process.env.API_KEY as string;
const APP_SECRET = "test-meta-app-secret-0123456789";
const VERIFY_TOKEN = "test-meta-verify-token-0123";
const PAGE_ID = "1111111111";
const PAGE_TOKEN = "EAAtestpagetoken0123456789";

const FORM: GraphForm = {
  id: "2222",
  name: "Schengen visa enquiry",
  questions: [
    { key: "which_country_do_you_want_to_visit?", label: "Which country do you want to visit?" },
    { key: "visa_type", label: "Visa type" },
    { key: "when_do_you_plan_to_travel?", label: "When do you plan to travel?" },
    { key: "how_many_travellers?", label: "How many travellers?" },
  ],
};

function graphLead(id: string, overrides: Partial<GraphLead> = {}): GraphLead {
  return {
    id,
    created_time: "2026-10-20T09:30:00+0000",
    form_id: FORM.id,
    ad_id: "3333",
    campaign_id: "4444",
    platform: "fb",
    field_data: [
      { name: "full_name", values: ["Aisha Khan"] },
      { name: "email", values: ["Aisha@Example.com"] },
      { name: "phone_number", values: ["+447700900123"] },
      { name: "which_country_do_you_want_to_visit?", values: ["france"] },
      { name: "visa_type", values: ["tourist_visa"] },
      { name: "when_do_you_plan_to_travel?", values: ["December 2026"] },
      { name: "how_many_travellers?", values: ["2"] },
    ],
    ...overrides,
  };
}

/** A Graph double: leads by id, one form, call counts so tests can see what was fetched. */
function fakeGraph(leads: GraphLead[]) {
  const calls = { getLead: 0 };
  const state = { failLead: null as MetaGraphError | null };
  const graph: MetaClient = {
    async getLead(id) {
      calls.getLead++;
      if (state.failLead) {
        const error = state.failLead;
        state.failLead = null;
        throw error;
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) throw new MetaGraphError("Facebook: Unsupported get request.", { status: 400, metaCode: 100, retriable: false });
      return lead;
    },
    async getForm() {
      return FORM;
    },
    async getPage(id) {
      return { id, name: "Europe Visa Centre" };
    },
    async *forms() {
      yield [FORM];
    },
    async *leads(_formId, _token, since) {
      const matching = leads.filter((l) => !since || new Date(l.created_time) >= since);
      // Two pages, to exercise paging, after a tick as a real request would take.
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield matching.slice(0, 1);
      yield matching.slice(1);
    },
    async subscribedApps() {
      return [{ id: "4196614413809427", subscribed_fields: ["leadgen"] }];
    },
    async subscribeLeadgen() {
      return true;
    },
  };
  return { graph, calls, state };
}

function setup(leads: GraphLead[] = [graphLead("9001")]) {
  const repository = createFakeRepository();
  const fake = fakeGraph(leads);
  const facebookLeadService = createFacebookLeadService({
    repository,
    graph: fake.graph,
    pageTokens: new Map([[PAGE_ID, PAGE_TOKEN]]),
    appId: "4196614413809427",
  });
  /* The real app for the CRM-facing routes, plus a signed webhook mounted the
     same way app.ts mounts it, with a known app secret. */
  const app = createApp({ facebookLeadService, enquiryService: createEnquiryService(repository, fakeServiceDeps()) });
  const signed = express();
  signed.use(META_WEBHOOK_PATH, metaWebhookBody);
  signed.use(
    "/api/v1/meta",
    metaRouter(facebookLeadService, { appSecret: () => APP_SECRET, verifyToken: () => VERIFY_TOKEN }),
  );
  signed.use(errorHandler);
  return { app, signed, repository, service: facebookLeadService, ...fake };
}

function delivery(leadgenIds: string[], pageId = PAGE_ID) {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1_792_000_000,
        changes: leadgenIds.map((id) => ({
          field: "leadgen",
          value: { leadgen_id: id, page_id: pageId, form_id: FORM.id, created_time: 1_792_000_000 },
        })),
      },
    ],
  });
}

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function post(app: express.Express, body: string, signature: string | null = sign(body)) {
  const req = request(app).post(META_WEBHOOK_PATH).set("content-type", "application/json");
  return (signature ? req.set("x-hub-signature-256", signature) : req).send(body);
}

describe("GET /api/v1/meta/webhook (verification)", () => {
  const { signed } = setup();
  const verify = (query: Record<string, string>) => request(signed).get(META_WEBHOOK_PATH).query(query);

  it("echoes the challenge as plain text when the verify token matches", async () => {
    const res = await verify({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" });
    expect(res.status).toBe(200);
    expect(res.text).toBe("1158201444");
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("refuses a wrong token, a wrong mode or a challenge that is not a plain token", async () => {
    for (const query of [
      { "hub.mode": "subscribe", "hub.verify_token": "wrong-token-000000000", "hub.challenge": "1" },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "<script>" },
    ]) {
      expect((await verify(query)).status).toBe(403);
    }
  });
});

describe("POST /api/v1/meta/webhook", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("rejects a delivery with no signature or the wrong one, storing nothing", async () => {
    const body = delivery(["9001"]);
    expect((await post(ctx.signed, body, null)).status).toBe(401);
    expect((await post(ctx.signed, body, sign(body, "another-secret-0123456789"))).status).toBe(401);
    expect((await post(ctx.signed, body, sign(`${body} `))).status).toBe(401);
    expect(ctx.repository.rows).toHaveLength(0);
    expect(ctx.calls.getLead).toBe(0);
  });

  it("fetches the lead from Graph and stores it as a facebook enquiry", async () => {
    const res = await post(ctx.signed, delivery(["9001"]));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: 1, created: 1, duplicates: 0, failed: 0 });

    const [row] = ctx.repository.rows;
    expect(row).toMatchObject({
      name: "Aisha Khan",
      email: "aisha@example.com",
      phone: "+447700900123",
      destination: "France",
      visaType: "Tourist Visa",
      travelMonth: "December 2026",
      source: "facebook",
      externalId: "9001",
      status: "new",
    });
    expect(row!.createdAt.toISOString()).toBe("2026-10-20T09:30:00.000Z");
    expect(row!.message).toContain('form "Schengen visa enquiry"');
    expect(row!.message).toContain("How many travellers?: 2");
    expect(row!.leadDetails).toMatchObject({ pageId: PAGE_ID, pageName: "Europe Visa Centre", formName: FORM.name, adId: "3333" });
  });

  it("stores a redelivered lead once, without calling Graph again", async () => {
    await post(ctx.signed, delivery(["9001"]));
    const again = await post(ctx.signed, delivery(["9001"]));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: 0, duplicates: 1 });
    expect(ctx.repository.rows).toHaveLength(1);
    expect(ctx.calls.getLead).toBe(1);
  });

  it("answers 500 when Graph fails, so Meta redelivers, and stores the lead on the retry", async () => {
    ctx.state.failLead = new MetaGraphError("Facebook did not respond in time.", { status: 0, retriable: true });
    expect((await post(ctx.signed, delivery(["9001"]))).status).toBe(500);
    expect(ctx.repository.rows).toHaveLength(0);

    expect((await post(ctx.signed, delivery(["9001"]))).status).toBe(200);
    expect(ctx.repository.rows).toHaveLength(1);
  });

  it("answers 500 for a page with no access token configured", async () => {
    expect((await post(ctx.signed, delivery(["9001"], "5555555555"))).status).toBe(500);
    expect(ctx.repository.rows).toHaveLength(0);
  });

  it("acknowledges deliveries for other objects and fields without doing anything", async () => {
    const body = JSON.stringify({ object: "page", entry: [{ id: PAGE_ID, changes: [{ field: "feed", value: {} }] }] });
    const res = await post(ctx.signed, body);
    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(0);
  });

  it("rejects a signed body that is not JSON", async () => {
    expect((await post(ctx.signed, "not json")).status).toBe(422);
  });
});

describe("mapFacebookLead", () => {
  it("joins first and last name, drops an invalid email and keeps phone-only leads", () => {
    const lead = graphLead("1", {
      field_data: [
        { name: "first_name", values: ["Omar"] },
        { name: "last_name", values: ["Farooq"] },
        { name: "email", values: ["not-an-email"] },
        { name: "phone_number", values: ["+923001234567"] },
      ],
      platform: "ig",
    });
    const mapped = mapFacebookLead(lead, { pageId: PAGE_ID });
    expect(mapped).toMatchObject({ name: "Omar Farooq", email: null, phone: "+923001234567" });
    expect(mapped.destination).toBe(NOT_SPECIFIED);
    expect(mapped.leadDetails).toMatchObject({ platform: "instagram" });
    expect(mapped.activityDescription).toBe("Lead received from Instagram Lead Ads");
    expect(mapped.message.length).toBeGreaterThanOrEqual(10);
  });

  it("falls back to the contact details, then a placeholder, for a lead with no name", () => {
    expect(mapFacebookLead(graphLead("1", { field_data: [{ name: "email", values: ["a@b.co"] }] }), { pageId: PAGE_ID }).name).toBe("a@b.co");
    expect(mapFacebookLead(graphLead("1", { field_data: [] }), { pageId: PAGE_ID }).name).toBe("Facebook lead");
  });

  it("does not mistake a traveller count for the travel month", () => {
    const lead = graphLead("1", {
      field_data: [
        { name: "full_name", values: ["Sara Malik"] },
        { name: "how_many_travellers?", values: ["2"] },
      ],
    });
    const mapped = mapFacebookLead(lead, { pageId: PAGE_ID, form: FORM });
    expect(mapped.travelMonth).toBe(NOT_SPECIFIED);
    expect(mapped.message).toContain("How many travellers?: 2");
  });

  it("keeps every answer, labelled, in leadDetails", () => {
    const mapped = mapFacebookLead(graphLead("1"), { pageId: PAGE_ID, form: FORM });
    expect((mapped.leadDetails as { answers: unknown[] }).answers).toContainEqual({
      key: "how_many_travellers?",
      label: "How many travellers?",
      value: "2",
    });
  });
});

describe("importing existing leads", () => {
  it("imports every lead across pages of results and skips ones already stored", async () => {
    const ctx = setup([graphLead("9001"), graphLead("9002"), graphLead("9003")]);
    await post(ctx.signed, delivery(["9002"]));

    await ctx.service.runImport([PAGE_ID], {});
    expect(ctx.service.importState()).toMatchObject({ forms: 1, imported: 2, duplicates: 1, failed: 0 });
    expect(ctx.repository.rows.map((r) => r.externalId).sort()).toEqual(["9001", "9002", "9003"]);
  });

  it("starts in the background, reports progress and refuses a second run meanwhile", async () => {
    const ctx = setup([graphLead("9001")]);
    const start = await request(ctx.app).post("/api/v1/meta/import").set("x-api-key", API_KEY).send({});
    expect(start.status).toBe(202);
    expect(start.body.data.status).toBe("running");
    expect((await request(ctx.app).post("/api/v1/meta/import").set("x-api-key", API_KEY).send({})).status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const progress = await request(ctx.app).get("/api/v1/meta/import").set("x-api-key", API_KEY);
    expect(progress.body.data).toMatchObject({ status: "succeeded", imported: 1 });
  });

  it("rejects an import for a page that is not configured", async () => {
    const ctx = setup();
    const res = await request(ctx.app).post("/api/v1/meta/import").set("x-api-key", API_KEY).send({ pageId: "5555555555" });
    expect(res.status).toBe(422);
  });
});

describe("CRM-facing routes", () => {
  it("require the API key", async () => {
    const { app } = setup();
    for (const path of ["/api/v1/meta/status", "/api/v1/meta/import"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post(`/api/v1/meta/pages/${PAGE_ID}/subscribe`)).status).toBe(401);
  });

  it("report each page's subscription without ever returning a token", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/v1/meta/status").set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.pages).toEqual([{ id: PAGE_ID, name: "Europe Visa Centre", subscribed: true, error: null }]);
    expect(JSON.stringify(res.body)).not.toContain(PAGE_TOKEN);
  });

  it("subscribe a configured page and 404 an unknown one", async () => {
    const { app } = setup();
    expect((await request(app).post(`/api/v1/meta/pages/${PAGE_ID}/subscribe`).set("x-api-key", API_KEY)).status).toBe(200);
    expect((await request(app).post("/api/v1/meta/pages/5555555555/subscribe").set("x-api-key", API_KEY)).status).toBe(404);
  });

  it("list facebook leads through the enquiries source filter", async () => {
    const ctx = setup();
    await post(ctx.signed, delivery(["9001"]));
    const res = await request(ctx.app).get("/api/v1/enquiries?source=facebook").set("x-api-key", API_KEY);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ source: "facebook", leadDetails: { formName: FORM.name } });
    expect((await request(ctx.app).get("/api/v1/enquiries?source=website").set("x-api-key", API_KEY)).body.data).toHaveLength(0);
  });
});

describe("Graph client", () => {
  it("sends the token as a header with appsecret_proof, never in the URL", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const client = createMetaClient(
      { appSecret: APP_SECRET, graphVersion: "v23.0", timeoutMs: 1_000 },
      (async (url: URL, init: RequestInit) => {
        seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
        return new Response(JSON.stringify(graphLead("9001")), { status: 200 });
      }) as unknown as typeof fetch,
    );
    await client.getLead("9001", PAGE_TOKEN);
    expect(seen!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v23\.0\/9001\?/);
    expect(seen!.url).not.toContain(PAGE_TOKEN);
    expect(new URL(seen!.url).searchParams.get("appsecret_proof")).toBe(
      createHmac("sha256", APP_SECRET).update(PAGE_TOKEN).digest("hex"),
    );
    expect(seen!.auth).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it("turns a Graph error into a MetaGraphError, retriable only when transient", async () => {
    const answer = (status: number, code: number) =>
      createMetaClient({ graphVersion: "v23.0", timeoutMs: 1_000 }, (async () =>
        new Response(JSON.stringify({ error: { message: "Nope", code, fbtrace_id: "abc" } }), { status })) as unknown as typeof fetch);

    await expect(answer(400, 190).getLead("1", PAGE_TOKEN)).rejects.toMatchObject({ retriable: false, metaCode: 190 });
    await expect(answer(500, 2).getLead("1", PAGE_TOKEN)).rejects.toMatchObject({ retriable: true });
  });
});
