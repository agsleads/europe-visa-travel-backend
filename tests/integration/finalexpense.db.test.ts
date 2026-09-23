import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import { finalExpenseWebhookSchema } from "@/domain/finalexpense.schema";
import { finalExpenseLeadRepository } from "@/repositories/finalexpense.repository";
import { createFinalExpenseService } from "@/services/finalexpense.service";
import { validFinalExpensePayload } from "../helpers/fakeFinalExpenseRepository";

/**
 * Final Expense leads against a real PostgreSQL database. Skipped unless
 * TEST_DATABASE_URL is set, exactly like the enquiry integration suite:
 *
 *   createdb evc_test
 *   TEST_DATABASE_URL=postgresql://localhost:5432/evc_test npm test
 *
 * The URL must point at a throwaway database: the suite truncates the Final
 * Expense tables before every test.
 */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("final expense leads (PostgreSQL)", () => {
  const service = createFinalExpenseService(finalExpenseLeadRepository);

  /** Parse a body exactly as the route would, then record it. */
  const record = (overrides: Record<string, unknown> = {}) => {
    const raw = validFinalExpensePayload(overrides);
    return service.record(finalExpenseWebhookSchema.parse(raw), raw);
  };

  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    // RESTART IDENTITY so id assertions do not depend on test ordering.
    await query(
      "TRUNCATE final_expense_lead_consents, final_expense_leads RESTART IDENTITY",
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("round-trips a lead, its consent and its raw payload through the real schema", async () => {
    const { lead, duplicate } = await record();
    expect(duplicate).toBe(false);

    const found = await service.getById(lead.id);
    expect(found).toMatchObject({
      firstName: "Margaret",
      lastName: "O'Connor",
      phoneE164: "+13075550142",
      zip: "82001",
      age: 70,
      coverageAmount: 15000,
      source: "finalexpensecoverage.us",
      isRepeat: false,
      relatedLeadIds: [],
    });
    expect(found.consent.version).toBe("fec-tcpa-2026-09-18");
    expect(found.consent.ipAddress).toBe("198.51.100.23");
    expect((found.rawPayload as { submissionId: string }).submissionId).toBe(
      "4f7d1c52-9b8e-4a3f-8d6c-2e1b0a9f7c33",
    );
  });

  /* node-postgres parses a DATE into a local-midnight JavaScript Date, which
     serialises a day early on any server west of UTC. The repository formats it
     in SQL instead; this pins that the birthday comes back as the exact string
     that went in, whatever the process timezone. */
  it("returns the date of birth as the exact calendar date stored", async () => {
    const { lead } = await record();
    const found = await service.getById(lead.id);
    expect(found.dateOfBirth).toBe("1955-11-03");
  });

  it("is idempotent on the submission id at the database level", async () => {
    const first = await record();
    const second = await record();

    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);

    const { rows } = await query<{ leads: string; consents: string }>(
      `SELECT (SELECT COUNT(*) FROM final_expense_leads) AS leads,
              (SELECT COUNT(*) FROM final_expense_lead_consents) AS consents`,
    );
    // One lead, and exactly one consent row: a retry must not append a second.
    expect(rows[0]).toEqual({ leads: "1", consents: "1" });
  });

  it("flags a later lead from the same person and links them both ways", async () => {
    const first = await record();
    const second = await record({ submissionId: "second-submission-0001" });

    expect(second.lead.isRepeat).toBe(true);
    const detail = await service.getById(first.lead.id);
    expect(detail.relatedLeadIds).toEqual([second.lead.id]);
  });

  it("lists newest first with a consistent total, and searches name, email, phone and ZIP", async () => {
    await record();
    await record({
      submissionId: "another-person-0001",
      answers: {
        ...(validFinalExpensePayload().answers as object),
        firstName: "Walter",
        lastName: "Reyes",
        email: "walter@example.org",
        phone: "(720) 555-0199",
        zip: "80202",
      },
    });

    const all = await service.list({ limit: 25, offset: 0 });
    expect(all.pagination.total).toBe(2);
    expect(all.items.map((l) => l.firstName)).toEqual(["Walter", "Margaret"]);

    for (const q of ["reyes", "walter@example", "7205550199", "80202"]) {
      const hit = await service.list({ q, limit: 25, offset: 0 });
      expect(hit.items.map((l) => l.firstName), q).toEqual(["Walter"]);
    }

    // `%` is a literal character in a search, never a wildcard.
    expect((await service.list({ q: "%", limit: 25, offset: 0 })).pagination.total).toBe(0);

    const page = await service.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.pagination).toMatchObject({ total: 2, hasMore: true });
  });

  it("counts leads for the overview tiles", async () => {
    await record();
    await record({ submissionId: "second-submission-0002" });

    await expect(service.stats()).resolves.toEqual({
      total: 2,
      today: 2,
      last7Days: 2,
      last30Days: 2,
    });
  });

  /* The application caps these too. The database checks exist because the
     application is not the only thing that will ever write to this table. */
  it("enforces its shape constraints at the database level", async () => {
    await expect(
      query(
        `INSERT INTO final_expense_leads
           (dedupe_key, submitted_at, source, first_name, last_name, phone_raw,
            email, email_normalised, zip, date_of_birth, age, coverage_amount, raw_payload)
         VALUES (repeat('a', 64), NOW(), 's', 'a', 'b', '1', 'no-at-sign', 'x',
                 '82001', '1950-01-01', 70, 5000, '{}')`,
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("refuses to delete a lead that still has its consent record", async () => {
    const { lead } = await record();
    await expect(
      query("DELETE FROM final_expense_leads WHERE id = $1", [lead.id]),
    /* 23001, not 23503: Postgres reports ON DELETE RESTRICT as
       restrict_violation. NO ACTION would give foreign_key_violation. */
    ).rejects.toMatchObject({ code: "23001" }); // restrict_violation
  });

  it("is idempotent when migrations are re-run", async () => {
    await expect(migrate(path.join(__dirname, "../../src/db/migrations"))).resolves.toEqual([]);
  });
});
