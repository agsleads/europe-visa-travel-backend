import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "@/api/app";

const API_KEY = process.env.API_KEY as string;

describe("/api/v1/domains", () => {
  const domains = [
    { key: "evc", name: "Europe Visa Centre", description: "Visa enquiries" },
    { key: "roadcover", name: "Road Cover", description: null },
  ];
  const app = createApp({ domainRepository: { list: async () => domains } });

  it("lists the domains", async () => {
    const response = await request(app).get("/api/v1/domains").set("x-api-key", API_KEY);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(domains);
  });

  it("requires the API key", async () => {
    await expect(request(app).get("/api/v1/domains")).resolves.toMatchObject({ status: 401 });
  });
});
