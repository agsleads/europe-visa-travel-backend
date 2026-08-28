import { describe, expect, it } from "vitest";

import { parseEnv } from "@/config/env";

const base = { DATABASE_URL: "postgresql://localhost:5432/evc" } as NodeJS.ProcessEnv;

describe("environment validation", () => {
  it("applies sensible defaults", () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 4000, DATABASE_POOL_MAX: 10 });
  });

  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  /* The single most dangerous misconfiguration: a public write endpoint with
     no authentication. It must be impossible to boot into, not a warning. */
  it("refuses to boot in production without an API key", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/API_KEY/);
  });

  it("rejects a trivially short API key", () => {
    expect(() => parseEnv({ ...base, API_KEY: "short" })).toThrow(/API_KEY/);
  });

  it("parses CORS origins from a comma-separated list, ignoring blanks", () => {
    const env = parseEnv({ ...base, CORS_ORIGINS: "https://a.com, https://b.com ,," });
    expect(env.CORS_ORIGINS).toEqual(["https://a.com", "https://b.com"]);
  });

  it("defaults CORS to no browser origin at all", () => {
    expect(parseEnv(base).CORS_ORIGINS).toEqual([]);
  });

  it("does not echo secret values in the failure message", () => {
    try {
      parseEnv({ ...base, API_KEY: "super-secret-but-too", PORT: "0" } as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret");
    }
  });
});
