import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import { enquiryRepository } from "@/repositories/enquiry.repository";
import { createEnquiryService } from "@/services/enquiry.service";
import { toCreateEnquiry } from "../helpers/fakeRepository";

/**
 * These run against a real PostgreSQL database and are skipped unless
 * TEST_DATABASE_URL is set — so `npm test` stays green on a laptop with no
 * database, while CI (which sets the variable) exercises the SQL, the
 * constraints, the trigger and the migration runner for real.
 *
 *   createdb evc_test
 *   TEST_DATABASE_URL=postgresql://localhost:5432/evc_test npm test
 *
 * The URL must point at a throwaway database: the suite truncates the table
 * before every test.
 */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("enquiries (PostgreSQL)", () => {
  const service = createEnquiryService(enquiryRepository);

  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    // RESTART IDENTITY so id assertions do not depend on test ordering.
    await query("TRUNCATE enquiries RESTART IDENTITY");
  });

  afterAll(async () => {
    await closePool();
  });

  it("round-trips an enquiry through the real schema", async () => {
    const created = await service.create(toCreateEnquiry());
    const found = await service.getById(created.id);

    expect(found).toMatchObject({
      email: "aisha@example.com",
      destination: "France",
      status: "new",
      consent: true,
    });
    expect(found.consentedAt).toBeInstanceOf(Date);
  });

  it("is idempotent when migrations are re-run", async () => {
    await expect(migrate(path.join(__dirname, "../../src/db/migrations"))).resolves.toEqual([]);
  });

  it("enforces the unique reference at the database level", async () => {
    const first = await enquiryRepository.create({
      ...toCreateEnquiry(),
      reference: "EVC-ABC123",
    });
    expect(first.reference).toBe("EVC-ABC123");

    await expect(
      enquiryRepository.create({ ...toCreateEnquiry(), reference: "EVC-ABC123" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  /* The application caps these too. The database check exists because the
     application is not the only thing that will ever write this table. */
  it("rejects an out-of-range message at the database level", async () => {
    await expect(
      enquiryRepository.create({
        ...toCreateEnquiry({ message: "short" }),
        reference: "EVC-CHK001",
      }),
    ).rejects.toThrow();
  });

  it("rejects a status outside the allowed set", async () => {
    const created = await service.create(toCreateEnquiry());
    await expect(
      query("UPDATE enquiries SET status = $2 WHERE id = $1", [created.id, "archived"]),
    ).rejects.toThrow();
  });

  it("maintains updated_at through the trigger, not the application", async () => {
    const created = await service.create(toCreateEnquiry());
    // Postgres timestamps are microsecond-precision, but two statements in the
    // same millisecond would still compare equal — nudge the clock forward.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const updated = await service.updateStatus(created.id, "in_progress");

    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("paginates newest-first with a consistent total", async () => {
    for (let i = 0; i < 5; i++) {
      await service.create(toCreateEnquiry({ email: `p${i}@example.com` }));
    }

    const page = await service.list({ limit: 2, offset: 0 });

    expect(page.items).toHaveLength(2);
    expect(page.pagination.total).toBe(5);
    expect(page.items[0]!.id).toBeGreaterThan(page.items[1]!.id);
  });

  it("purges only closed and spam rows past the retention window", async () => {
    const keep = await service.create(toCreateEnquiry());
    const drop = await service.create(toCreateEnquiry({ email: "old@example.com" }));

    await query("UPDATE enquiries SET created_at = NOW() - INTERVAL '400 days'");
    await service.updateStatus(drop.id, "closed");

    expect(await service.purge(365)).toBe(1);
    await expect(service.getById(keep.id)).resolves.toBeTruthy();
  });

  /* Values are bound, never interpolated. This is the regression test for
     anyone who later "just adds" a string-concatenated filter. */
  it("searches across reference, name, email and destination", async () => {
    await service.create(toCreateEnquiry({ name: "Aisha Rahman", email: "aisha@example.com" }));
    const tom = await service.create(
      toCreateEnquiry({ name: "Tom Baker", email: "tom@elsewhere.test", destination: "Italy" }),
    );

    const byName = await enquiryRepository.list({ q: "rahman", limit: 20, offset: 0 });
    expect(byName.items.map((e) => e.name)).toEqual(["Aisha Rahman"]);

    const byEmail = await enquiryRepository.list({ q: "elsewhere", limit: 20, offset: 0 });
    expect(byEmail.items.map((e) => e.id)).toEqual([tom.id]);

    const byDestination = await enquiryRepository.list({ q: "italy", limit: 20, offset: 0 });
    expect(byDestination.items.map((e) => e.id)).toEqual([tom.id]);

    // References are stored uppercase; the search lowers both sides so an
    // operator can type one without matching its case.
    const byReference = await enquiryRepository.list({
      q: tom.reference.toLowerCase(),
      limit: 20,
      offset: 0,
    });
    expect(byReference.items.map((e) => e.id)).toEqual([tom.id]);
  });

  /* The reason the query uses POSITION rather than ILIKE. Under a LIKE pattern
     these terms are wildcards: "%" would match every row and "_" would match
     any single character, so the filter would quietly answer a different
     question than the operator typed. */
  it("treats LIKE metacharacters in a search term as literal text", async () => {
    await service.create(toCreateEnquiry({ name: "Ada Lovelace" }));
    const discounted = await service.create(toCreateEnquiry({ name: "Bob 50% Off" }));

    const percent = await enquiryRepository.list({ q: "50%", limit: 20, offset: 0 });
    expect(percent.items.map((e) => e.id)).toEqual([discounted.id]);

    // "_" must not act as a single-character wildcard: no name contains one.
    const underscore = await enquiryRepository.list({ q: "a_a", limit: 20, offset: 0 });
    expect(underscore.items).toEqual([]);

    // A bare "%" would match everything under LIKE. It matches only the row
    // that literally contains one.
    const bare = await enquiryRepository.list({ q: "%", limit: 20, offset: 0 });
    expect(bare.items.map((e) => e.id)).toEqual([discounted.id]);
  });

  it("reports counts for every status, including those with no rows", async () => {
    const first = await service.create(toCreateEnquiry());
    await service.create(toCreateEnquiry());
    await service.updateStatus(first.id, "closed");

    const stats = await enquiryRepository.stats();

    expect(stats.total).toBe(2);
    expect(stats.byStatus).toEqual({
      new: 1,
      in_progress: 0,
      responded: 0,
      closed: 1,
      spam: 0,
    });
    expect(stats.last7Days).toBe(2);
  });

  it("treats SQL metacharacters in input as data", async () => {
    const created = await service.create(
      toCreateEnquiry({ name: "Robert'); DROP TABLE enquiries;--" }),
    );

    const found = await service.getById(created.id);
    expect(found.name).toBe("Robert'); DROP TABLE enquiries;--");
    await expect(query("SELECT COUNT(*) FROM enquiries")).resolves.toBeTruthy();
  });
});
