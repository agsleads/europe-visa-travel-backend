import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createBlacklistClient, type BlacklistConfig } from "@/services/blacklist.client";

const PATH = "/api/v1/blacklist/lookup";

const CONFIG: BlacklistConfig = {
  apiKey: "bla-test-key-123",
  baseUrl: "https://api.blacklistalliance.net",
  timeoutMs: 2_000,
};

/** A v1 "Good" answer, shaped like the provider's schema. */
const GOOD = {
  sid: "6f1c3a8e-2b4d-4c1e-9a7f-0d2e3b4c5a6f",
  status: "success",
  message: "Good",
  code: [],
  offset: 1623857287280716,
  wireless: 0,
  phone: "2223334444",
  results: 0,
  time: 1,
  scrubs: 1,
};

/** Builds the real app with the real client, over a fake `fetch`. */
function appWith(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  config: Partial<BlacklistConfig> = {},
) {
  const blacklistClient = createBlacklistClient(
    { ...CONFIG, ...config },
    fetchImpl as unknown as typeof fetch,
  );
  return createApp({ blacklistClient });
}

const post = (app: ReturnType<typeof createApp>, body: unknown = { phone: "2223334444" }) =>
  request(app).post(PATH).send(body as object);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("POST /api/v1/blacklist/lookup", () => {
  it("looks the number up and returns the provider's response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const app = appWith(async (url, init) => {
      seen = { url, init };
      return json(GOOD);
    });

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: GOOD });

    const url = new URL(seen!.url);
    expect(url.origin + url.pathname).toBe("https://api.blacklistalliance.net/lookup");
    expect(url.searchParams.get("key")).toBe("bla-test-key-123");
    expect(url.searchParams.get("phone")).toBe("2223334444");
    expect(url.searchParams.get("resp")).toBe("json");
    expect(url.searchParams.has("ver")).toBe(false);
    expect(seen!.init.method).toBe("GET");
  });

  it("sends ver when a version is configured", async () => {
    let seen = "";
    const app = appWith(
      async (url) => {
        seen = url;
        return json(GOOD);
      },
      { version: "v3" },
    );

    await post(app);

    expect(new URL(seen).searchParams.get("ver")).toBe("v3");
  });

  it.each([
    ["(222) 333-4444", "2223334444"],
    ["+1 222 333 4444", "2223334444"],
    ["1-222-333-4444", "2223334444"],
  ])("normalises %s to %s", async (typed, expected) => {
    let seen = "";
    const app = appWith(async (url) => {
      seen = url;
      return json(GOOD);
    });

    const response = await post(app, { phone: typed });

    expect(response.status).toBe(200);
    expect(new URL(seen).searchParams.get("phone")).toBe(expected);
  });

  it.each([[{}], [{ phone: "" }], [{ phone: "12345" }], [{ phone: "1223334444" }], [{ phone: 2223334444 }]])(
    "rejects %j with 422 without calling the provider",
    async (body) => {
      let called = false;
      const app = appWith(async () => {
        called = true;
        return json(GOOD);
      });

      const response = await post(app, body);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("validation_failed");
      expect(response.body.error.details.fieldErrors.phone).toBeTruthy();
      expect(called).toBe(false);
    },
  );

  it("reports the provider's invalid-number 422 as a field error", async () => {
    const app = appWith(
      async () =>
        new Response("Invalid Phone", {
          status: 422,
          headers: { "Content-Type": "text/plain", "x-errmsg": "Invalid Phone" },
        }),
    );

    const response = await post(app);

    expect(response.status).toBe(422);
    expect(response.body.error.details.fieldErrors).toEqual({ phone: "Invalid Phone" });
  });

  it("turns a provider 403 into a 502 carrying the provider's reason", async () => {
    const app = appWith(
      async () =>
        new Response("API Key Not Found", {
          status: 403,
          headers: { "Content-Type": "text/plain", "x-errmsg": "API Key Not Found" },
        }),
    );

    const response = await post(app);

    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({
      code: "blacklist_rejected",
      upstreamStatus: 403,
      upstreamMessage: "API Key Not Found",
    });
    expect(JSON.stringify(response.body)).not.toContain("bla-test-key-123");
  });

  it("answers 503 when no key is configured", async () => {
    let called = false;
    const app = appWith(
      async () => {
        called = true;
        return json(GOOD);
      },
      { apiKey: undefined },
    );

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("blacklist_not_configured");
    expect(called).toBe(false);
  });

  it("answers 504 on a timeout and 502 when unreachable, without leaking the key", async () => {
    const timeout = appWith(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const down = appWith(async (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    });

    const timedOut = await post(timeout);
    const unreachable = await post(down);

    expect(timedOut.status).toBe(504);
    expect(timedOut.body.error.code).toBe("blacklist_timeout");
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error.code).toBe("blacklist_unreachable");
    expect(JSON.stringify(unreachable.body)).not.toContain("bla-test-key-123");
  });

  it("needs no API key", async () => {
    const app = appWith(async () => json(GOOD));

    const response = await request(app).post(PATH).send({ phone: "2223334444" });

    expect(response.status).toBe(200);
  });
});
