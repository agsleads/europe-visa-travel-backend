import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createCallGridClient, type CallGridConfig } from "@/services/callgrid.client";

const BID = "/api/v1/callgrid/bid";
const GRID = "cm97s8hmv000ijt06r4djmije";

const CONFIG: CallGridConfig = {
  gridId: GRID,
  baseUrl: "https://bid.callgrid.com",
  timeoutMs: 2_000,
};

/** The SIP success example from the CallGrid guide. */
const WON = {
  id: "cmbidlwefyn02316t3nkxnelxz",
  code: "1000",
  message: "Success",
  dynamicBid: "1.00",
  dynamicDuration: "10",
  expirationSeconds: "100",
  payOnDuplicates: false,
  dynamicSipAddress: "sip:cmbidlwefyn02316t3nkxnelxz@somewhere.sip.callgrid.com",
};

type Seen = { url: string; init: RequestInit; body: Record<string, unknown> };

/** Builds the real app with the real client, over a fake `fetch`. */
function appWith(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  config: Partial<CallGridConfig> = {},
) {
  const callGridClient = createCallGridClient(
    { ...CONFIG, ...config },
    fetchImpl as unknown as typeof fetch,
  );
  return createApp({ callGridClient });
}

/** An app whose fake CallGrid records each request and answers with `answer`. */
function recording(answer: () => Response, config: Partial<CallGridConfig> = {}) {
  const seen: Seen[] = [];
  const app = appWith(async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body as string) });
    return answer();
  }, config);
  return { app, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const bid = (app: ReturnType<typeof createApp>, body: unknown = { CallerId: "+15551234567" }) =>
  request(app).post(BID).send(body as object);

describe("POST /api/v1/callgrid/bid", () => {
  it("posts the bid to the Grid and returns CallGrid's response", async () => {
    const { app, seen } = recording(() => json(WON));

    const response = await bid(app, {
      CallerId: "+15551234567",
      InboundStateCode: "CO",
      InboundZipCode: "80301",
      age: 38,
      CampaignType: "insurance",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: WON });
    expect(seen[0]?.url).toBe(`https://bid.callgrid.com/api/bid/${GRID}`);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.body).toEqual({
      CallerId: "+15551234567",
      InboundStateCode: "CO",
      InboundZipCode: "80301",
      age: 38,
      CampaignType: "insurance",
    });
  });

  it.each([
    ["(555) 123-4567", "+15551234567"],
    ["5551234567", "+15551234567"],
    ["1 555 123 4567", "+15551234567"],
  ])("normalises CallerId %s to %s", async (typed, expected) => {
    const { app, seen } = recording(() => json(WON));

    const response = await bid(app, { CallerId: typed, InboundStateCode: "co" });

    expect(response.status).toBe(200);
    expect(seen[0]?.body.CallerId).toBe(expected);
    expect(seen[0]?.body.InboundStateCode).toBe("CO");
  });

  it("forwards pstn and passes a PSTN win through", async () => {
    const pstnWin = { ...WON, dynamicSipAddress: undefined, dynamicPhoneNumber: "+1234567890" };
    const { app, seen } = recording(() => json(pstnWin));

    const response = await bid(app, { CallerId: "+15551234567", pstn: true });

    expect(seen[0]?.body.pstn).toBe(true);
    expect(response.body.data.dynamicPhoneNumber).toBe("+1234567890");
  });

  it("passes a rejected bid through as 200, since HTTP 200 is how CallGrid says no", async () => {
    const rejected = { code: "4004", message: "Capacity check failed" };
    const { app } = recording(() => json(rejected));

    const response = await bid(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rejected });
  });

  it.each([
    [{}, "CallerId"],
    [{ CallerId: "" }, "CallerId"],
    [{ CallerId: "12345" }, "CallerId"],
    [{ CallerId: "+15551234567", InboundStateCode: "Colorado" }, "InboundStateCode"],
    [{ CallerId: "+15551234567", InboundZipCode: "8030" }, "InboundZipCode"],
    [{ CallerId: "+15551234567", pstn: "yes" }, "pstn"],
    [{ CallerId: "+15551234567", extra: { nested: true } }, "extra"],
  ])("rejects %j with 422 on %s without calling CallGrid", async (body, field) => {
    const { app, seen } = recording(() => json(WON));

    const response = await bid(app, body);

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors[field]).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it("rejects more than 30 fields", async () => {
    const { app, seen } = recording(() => json(WON));
    const extras = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));

    const response = await bid(app, { CallerId: "+15551234567", ...extras });

    expect(response.status).toBe(422);
    expect(seen).toHaveLength(0);
  });

  it("turns CallGrid's 429 into a 429 the caller can wait out", async () => {
    const { app } = recording(() => json({ code: "5001", message: "Rate limit exceeded" }, 429));

    const response = await bid(app);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("callgrid_rate_limited");
  });

  it("turns any other CallGrid HTTP error into a 502 without leaking the Grid ID", async () => {
    const { app } = recording(() => new Response("Internal error", { status: 500 }));

    const response = await bid(app);

    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({
      code: "callgrid_rejected",
      upstreamStatus: 500,
      upstreamResponse: "Internal error",
    });
    expect(JSON.stringify(response.body)).not.toContain(GRID);
  });

  it("answers 503 when no Grid ID is configured", async () => {
    const { app, seen } = recording(() => json(WON), { gridId: undefined });

    const response = await bid(app);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("callgrid_not_configured");
    expect(seen).toHaveLength(0);
  });

  it("answers 504 on a timeout and 502 when unreachable, without leaking the Grid ID", async () => {
    const timeout = appWith(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const down = appWith(async (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    });

    const timedOut = await bid(timeout);
    const unreachable = await bid(down);

    expect(timedOut.status).toBe(504);
    expect(timedOut.body.error.code).toBe("callgrid_timeout");
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error.code).toBe("callgrid_unreachable");
    expect(JSON.stringify(unreachable.body)).not.toContain(GRID);
  });
});

describe("POST /api/v1/callgrid/bid/:bidId/confirm", () => {
  const CONFIRM = `/api/v1/callgrid/bid/${WON.id}/confirm`;

  it("posts to the confirmation URL and returns CallGrid's response", async () => {
    const { app, seen } = recording(() => json(WON));

    const response = await request(app).post(CONFIRM).send({ CallerId: "5551234567" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: WON });
    expect(seen[0]?.url).toBe(`https://bid.callgrid.com/api/bid/confirmation/${WON.id}`);
    expect(seen[0]?.body).toEqual({ CallerId: "+15551234567" });
  });

  it("needs no body", async () => {
    const { app, seen } = recording(() => json(WON));

    const response = await request(app).post(CONFIRM).send({});

    expect(response.status).toBe(200);
    expect(seen[0]?.body).toEqual({});
  });

  it("passes an expired-bid answer through", async () => {
    const { app } = recording(() => json({ code: "4011", message: "Bid expired" }));

    const response = await request(app).post(CONFIRM).send({});

    expect(response.status).toBe(200);
    expect(response.body.data.code).toBe("4011");
  });

  it("rejects a malformed bid id without calling CallGrid", async () => {
    const { app, seen } = recording(() => json(WON));

    const response = await request(app).post("/api/v1/callgrid/bid/not-a-bid!/confirm").send({});

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors.bidId).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it("answers 503 when no Grid ID is configured", async () => {
    const { app, seen } = recording(() => json(WON), { gridId: undefined });

    const response = await request(app).post(CONFIRM).send({});

    expect(response.status).toBe(503);
    expect(seen).toHaveLength(0);
  });
});
