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
  sourceId: 859,
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
      "https://api.onyxplatform.com/api/v1/external/organizations/5/sources/859/utilization",
    );
    expect(seen?.init.method).toBe("POST");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("onyx-test-key-123");
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

  it("returns 503 without calling Onyx when ONYX_API_KEY is not set", async () => {
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

  it("rejects a request without the API key", async () => {
    const app = appWith(async () => new Response("{}", { status: 200 }));

    const response = await request(app).post(PATH).send(PAYLOAD);
    expect(response.status).toBe(401);
  });
});
