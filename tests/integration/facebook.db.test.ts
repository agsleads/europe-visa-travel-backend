import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import type { ExternalEnquiry } from "@/domain/enquiry.schema";
import { enquiryCrmRepository } from "@/repositories/enquiryCrm.repository";
import { enquiryRepository } from "@/repositories/enquiry.repository";

/** Facebook leads in the real enquiries table. Skipped without TEST_DATABASE_URL, like the others. */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const lead = (overrides: Partial<ExternalEnquiry> = {}): ExternalEnquiry => ({
  name: "Aisha Khan",
  email: null,
  phone: "+447700900123",
  destination: "France",
  visaType: "Not specified",
  travelMonth: "Not specified",
  message: "Submitted through Facebook Lead Ads.",
  source: "facebook",
  externalId: "9001",
  leadDetails: { provider: "facebook", leadId: "9001", answers: [] },
  receivedAt: new Date("2026-10-20T09:30:00Z"),
  activityDescription: "Lead received from Facebook Lead Ads",
  ...overrides,
});

describeDb("facebook leads (PostgreSQL)", () => {
  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    await query("TRUNCATE enquiries RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("stores a lead with no email, dated when it was submitted, with its timeline started", async () => {
    const stored = await enquiryRepository.createExternal({ ...lead(), reference: "EVC-FB0001" });
    expect(stored).toMatchObject({ email: null, source: "facebook", externalId: "9001", consent: true, status: "new" });
    expect(stored!.createdAt.toISOString()).toBe("2026-10-20T09:30:00.000Z");
    expect(stored!.leadDetails).toEqual({ provider: "facebook", leadId: "9001", answers: [] });

    const timeline = await enquiryCrmRepository.listActivities(stored!.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: "created", description: "Lead received from Facebook Lead Ads" });
  });

  it("returns null for a lead already stored, adding no row and no activity", async () => {
    await enquiryRepository.createExternal({ ...lead(), reference: "EVC-FB0001" });
    expect(await enquiryRepository.createExternal({ ...lead(), reference: "EVC-FB0002" })).toBeNull();
    const { rows } = await query<{ n: string }>("SELECT COUNT(*) AS n FROM enquiry_activities");
    expect(Number(rows[0]!.n)).toBe(1);
    expect(await enquiryRepository.existingExternalIds("facebook", ["9001", "9002"])).toEqual(new Set(["9001"]));
  });

  it("still raises a reference collision, so the service can retry it", async () => {
    await enquiryRepository.createExternal({ ...lead(), reference: "EVC-FB0001" });
    await expect(
      enquiryRepository.createExternal({ ...lead({ externalId: "9002" }), reference: "EVC-FB0001" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("filters, searches and facets by source with null emails present", async () => {
    await enquiryRepository.createExternal({ ...lead(), reference: "EVC-FB0001" });
    const fb = await enquiryRepository.list({ source: "facebook", sort: "createdAt", order: "desc", limit: 20, offset: 0 });
    expect(fb.total).toBe(1);
    const search = await enquiryRepository.list({ q: "aisha", sort: "createdAt", order: "desc", limit: 20, offset: 0 });
    expect(search.total).toBe(1);
    expect((await enquiryRepository.facets()).sources).toEqual(["facebook"]);
  });
});
