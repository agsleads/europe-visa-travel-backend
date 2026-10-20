import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createOnyxClient, type OnyxConfig } from "@/services/onyx.client";

const API_KEY = process.env.API_KEY as string;
const PATH = "/api/v1/onyx/utilization";

const CONFIG: OnyxConfig = {
  apiKey: "onyx-test-key-123",
  baseUrl: "https://api.onyxplatform.com",
  organizationId: 5,
  sourceId: 1046,
  timeoutMs: 2_000,
};

/** The example payload from the Onyx snippet. */
const PAYLOAD = {
  lead_phone_number: "+12345678901",
  state: "CA",
  zip_code: "94105",
  external_id: "my-id-123",
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: "1970-01-15",
  email: "jane.doe@example.com",
  address: "123 Main St",
  city: "San Francisco",
};

/** Builds the real app with the real Onyx client, over a fake `fetch`. */
function appWith(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  config: Partial<OnyxConfig> = {},
) {
  const onyxClient = createOnyxClient({ ...CONFIG, ...config }, fetchImpl as unknown as typeof fetch);
  return createApp({ onyxClient });
}

const post = (app: ReturnType<typeof createApp>, body: unknown = PAYLOAD) =>
  request(app).post(PATH).set("x-api-key", API_KEY).send(body as object);

describe("POST /api/v1/onyx/utilization", () => {
  it("forwards the payload to Onyx and returns Onyx's response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const app = appWith(async (url, init) => {
      seen = { url, init };
      return new Response('{"status":"accepted","id":"abc"}', { status: 200 });
    });

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "accepted", id: "abc" } });

    expect(seen?.url).toBe(
      "https://api.onyxplatform.com/api/v1/external/organizations/5/sources/1046/utilization",
    );
    expect(seen?.init.method).toBe("POST");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("onyx-test-key-123");
    // The guide authenticates with X-API-Key only; a stray Authorization
    // header would be a second credential travelling to a vendor.
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen?.init.body as string)).toEqual(PAYLOAD);
  });

  it("accepts a payload without the optional date_of_birth, address and city", async () => {
    let sent: Record<string, unknown> = {};
    const app = appWith(async (_url, init) => {
      sent = JSON.parse(init.body as string);
      return new Response("{}", { status: 200 });
    });

    const optional = ["date_of_birth", "address", "city"];
    const required = Object.fromEntries(
      Object.entries(PAYLOAD).filter(([key]) => !optional.includes(key)),
    );

    expect((await post(app, required)).status).toBe(200);
    expect(sent).toEqual(required);
  });

  it("accepts a phone number on its own", async () => {
    let sent: Record<string, unknown> = {};
    const app = appWith(async (_url, init) => {
      sent = JSON.parse(init.body as string);
      return new Response("{}", { status: 200 });
    });

    expect((await post(app, { lead_phone_number: "+14155550199" })).status).toBe(200);
    expect(sent).toEqual({ lead_phone_number: "+14155550199" });
  });

  it("returns 422 without a phone number", async () => {
    const app = appWith(async () => new Response("{}", { status: 200 }));

    const response = await post(app, { state: "CA", zip_code: "94105" });
    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toHaveProperty("lead_phone_number");
  });

  it("returns 422 and does not call Onyx when the body is invalid", async () => {
    let called = false;
    const app = appWith(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const response = await post(app, { ...PAYLOAD, lead_phone_number: "1234567890", zip_code: "941" });

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toMatchObject({
      lead_phone_number: expect.any(String),
      zip_code: expect.any(String),
    });
    expect(called).toBe(false);
  });

  it("returns 502 with Onyx's status and body when Onyx refuses", async () => {
    const app = appWith(
      async () => new Response('{"error":"duplicate external_id"}', { status: 422 }),
    );

    const response = await post(app);

    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({
      code: "onyx_rejected",
      onyxStatus: 422,
      onyxResponse: { error: "duplicate external_id" },
    });
  });

  it("returns a non-JSON Onyx body as text", async () => {
    const app = appWith(async () => new Response("Bad Gateway", { status: 500 }));

    const response = await post(app);
    expect(response.status).toBe(502);
    expect(response.body.error.onyxResponse).toBe("Bad Gateway");
  });

  it("returns 504 when Onyx times out", async () => {
    const app = appWith(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });

    const response = await post(app);
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe("onyx_timeout");
  });

  it("returns 502 when Onyx is unreachable", async () => {
    const app = appWith(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await post(app);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("onyx_unreachable");
  });

  it("returns 503 without calling Onyx when EVC_ONYX_API_KEY is not set", async () => {
    let called = false;
    const app = appWith(
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      { apiKey: undefined },
    );

    const response = await post(app);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("onyx_not_configured");
    expect(called).toBe(false);
  });

  /* Deliberately public, like /availability. Its caller is a static operator
     page with no server of its own, so the alternative was shipping a key
     that also unlocks /enquiries and /users. The rate limiter is what guards
     it now; see the note at the top of onyx.routes.ts. */
  it("is PUBLIC - serves a request carrying no API key at all", async () => {
    const app = appWith(
      async () =>
        new Response(JSON.stringify({ available: true, phone_number: "+15550001111", bid: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await request(app).post(PATH).send(PAYLOAD);
    expect(response.status).toBe(200);
  });

  it("returns Onyx's body verbatim, commercial terms included", async () => {
    const app = appWith(
      async () =>
        new Response(JSON.stringify({ available: true, phone_number: "+15550001111", bid: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await request(app).post(PATH).send(PAYLOAD);

    /* Asserted so the exposure is explicit rather than incidental: this route
       publishes the transfer number and our buy rate to any caller. If that
       ever stops being acceptable, this test is the one that should fail. */
    expect(response.body.data).toEqual({
      available: true,
      phone_number: "+15550001111",
      bid: 42,
    });
  });
});

/** What Onyx documents the ping as answering, in full. */
const ONYX_ANSWER = {
  phone_number: "+12603085865",
  available: true,
  duration: 300,
  bid: 10.5,
  billing_type: "duration",
};

describe("POST /api/v1/onyx/availability", () => {
  const AVAILABILITY = "/api/v1/onyx/availability";

  const ping = (app: ReturnType<typeof createApp>, body: unknown = PAYLOAD) =>
    request(app).post(AVAILABILITY).set("x-api-key", API_KEY).send(body as object);

  it("sends the same ping as /utilization", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const app = appWith(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(ONYX_ANSWER), { status: 200 });
    });

    await ping(app);

    expect(seen?.url).toBe(
      "https://api.onyxplatform.com/api/v1/external/organizations/5/sources/1046/utilization",
    );
    expect(JSON.parse(seen?.init.body as string)).toEqual(PAYLOAD);
  });

  it("answers with availability alone, withholding the number and the terms", async () => {
    const app = appWith(async () => new Response(JSON.stringify(ONYX_ANSWER), { status: 200 }));

    const response = await ping(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { available: true } });

    /* The whole point of this route: neither our buy rate nor the transfer
       number may reach a browser. Asserted against the serialised body, so a
       nested leak fails too. */
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("phone_number");
    expect(raw).not.toContain("2603085865");
    expect(raw).not.toContain("bid");
    expect(raw).not.toContain("10.5");
    expect(raw).not.toContain("duration");
    expect(raw).not.toContain("billing_type");
  });

  it("reports unavailable when no agents are available", async () => {
    const app = appWith(
      async () =>
        new Response(JSON.stringify({ ...ONYX_ANSWER, available: false }), { status: 200 }),
    );

    const response = await ping(app);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ available: false });
  });

  it("reports unavailable when Onyx's answer is not readable", async () => {
    for (const body of ["Service Unavailable", "null", '"ok"', "[]"]) {
      const app = appWith(async () => new Response(body, { status: 200 }));
      const response = await ping(app);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ available: false });
    }
  });

  it("treats a non-boolean `available` as unavailable", async () => {
    const app = appWith(
      async () =>
        new Response(JSON.stringify({ ...ONYX_ANSWER, available: "true" }), { status: 200 }),
    );

    const response = await ping(app);
    expect(response.body.data).toEqual({ available: false });
  });

  it("validates the body exactly as /utilization does", async () => {
    let called = false;
    const app = appWith(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const response = await ping(app, { lead_phone_number: "1234567890" });

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toHaveProperty("lead_phone_number");
    expect(called).toBe(false);
  });

  /* Deliberately public. The caller is a static lead form with no server of
     its own, so the only way to authenticate it would be to ship a key in the
     page -- which is not a key. The rate limiter is what guards this route
     instead; see the note at the top of onyx.routes.ts. */
  it("is PUBLIC - serves a request carrying no API key at all", async () => {
    const app = appWith(async () =>
      new Response(JSON.stringify({ available: true, phone_number: "+15550001111", bid: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await request(app).post(AVAILABILITY).send(PAYLOAD);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ available: true });
  });

  it("still withholds the number and the buy rate when called anonymously", async () => {
    const app = appWith(async () =>
      new Response(JSON.stringify({ available: true, phone_number: "+15550001111", bid: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await request(app).post(AVAILABILITY).send(PAYLOAD);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain("5550001111");
    expect(body).not.toContain("42");
    expect(body).not.toContain("bid");
  });

  it("still reduces the body, even though /utilization is now open too", async () => {
    const app = appWith(
      async () =>
        new Response(JSON.stringify({ available: true, phone_number: "+15550001111", bid: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    /* The two routes are open to the same callers now, so the ONLY thing
       separating them is what each returns. That distinction is the whole
       reason /availability still exists. */
    const avail = await request(app).post(AVAILABILITY).send(PAYLOAD);
    const util = await request(app).post("/api/v1/onyx/utilization").send(PAYLOAD);

    expect(avail.body.data).toEqual({ available: true });
    expect(util.body.data).toHaveProperty("bid");
  });
});
