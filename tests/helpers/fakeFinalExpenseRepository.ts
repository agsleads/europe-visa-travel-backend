import type {
  CreateFinalExpenseLead,
  FinalExpenseLead,
  FinalExpenseLeadDetail,
  FinalExpenseWebhookInput,
} from "@/domain/finalexpense.schema";
import type {
  CreateFinalExpenseLeadResult,
  FinalExpenseLeadRepository,
} from "@/repositories/finalexpense.repository";

/**
 * In-memory Final Expense repository with the same contract as the Postgres
 * one, including its idempotency on `dedupe_key` -- the duplicate path in the
 * route is only meaningfully testable if the fake actually deduplicates.
 */

interface StoredLead extends FinalExpenseLead {
  dedupeKey: string;
  emailNormalised: string;
  dateOfBirth: string;
  rawPayload: unknown;
  consent: CreateFinalExpenseLead["consent"];
}

export function createFakeFinalExpenseRepository(): FinalExpenseLeadRepository & {
  rows: StoredLead[];
  failNext?: Error;
} {
  const rows: StoredLead[] = [];
  let nextId = 1;

  const fake: FinalExpenseLeadRepository & { rows: StoredLead[]; failNext?: Error } = {
    rows,

    async create(input: CreateFinalExpenseLead): Promise<CreateFinalExpenseLeadResult> {
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }

      const existing = rows.find((r) => r.dedupeKey === input.dedupeKey);
      if (existing) return { lead: existing, duplicate: true };

      const lead: StoredLead = {
        id: nextId++,
        dedupeKey: input.dedupeKey,
        submittedAt: input.submittedAt,
        source: input.source,
        firstName: input.firstName,
        lastName: input.lastName,
        phoneRaw: input.phoneRaw,
        phoneE164: input.phoneE164,
        email: input.email,
        emailNormalised: input.emailNormalised,
        zip: input.zip,
        dateOfBirth: input.dateOfBirth,
        age: input.age,
        coverageAmount: input.coverageAmount,
        createdAt: new Date(),
        isRepeat: rows.some(
          (r) =>
            r.emailNormalised === input.emailNormalised ||
            (r.phoneE164 !== null && r.phoneE164 === input.phoneE164),
        ),
        rawPayload: input.rawPayload,
        consent: input.consent,
      };

      rows.push(lead);
      return { lead, duplicate: false };
    },

    async findById(id: number): Promise<FinalExpenseLeadDetail | null> {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      return {
        ...row,
        relatedLeadIds: rows
          .filter(
            (r) =>
              r.id !== row.id &&
              (r.emailNormalised === row.emailNormalised ||
                (r.phoneE164 !== null && r.phoneE164 === row.phoneE164)),
          )
          .map((r) => r.id),
        consent: { ...row.consent },
      };
    },

    async list(params) {
      let items = [...rows].reverse();

      if (params.q) {
        const needle = params.q.toLowerCase();
        const digits = params.q.replace(/\D/g, "");
        items = items.filter(
          (r) =>
            `${r.firstName} ${r.lastName}`.toLowerCase().includes(needle) ||
            r.email.toLowerCase().includes(needle) ||
            r.zip.includes(needle) ||
            (digits !== "" && r.phoneRaw.replace(/\D/g, "").includes(digits)),
        );
      }

      return {
        items: items.slice(params.offset, params.offset + params.limit),
        total: items.length,
      };
    },

    async stats() {
      return {
        total: rows.length,
        today: rows.length,
        last7Days: rows.length,
        last30Days: rows.length,
      };
    },
  };

  return fake;
}

/**
 * A complete, valid request body, shaped exactly as the Final Expense site's
 * server route sends it.
 *
 * `overrides` are merged at the top level only; the nested objects take a full
 * replacement, which keeps the helper honest about what a test is changing.
 */
export function validFinalExpensePayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload: FinalExpenseWebhookInput = {
    submissionId: "4f7d1c52-9b8e-4a3f-8d6c-2e1b0a9f7c33",
    receivedAt: "2026-09-20T14:05:12.000Z",
    source: "finalexpensecoverage.us",
    answers: {
      firstName: "Margaret",
      lastName: "O'Connor",
      phone: "(307) 555-0142",
      email: "Margaret.OConnor@Example.com",
      zip: "82001",
      dateOfBirth: "1955-11-03",
      coverageAmount: 15000,
    },
    consent: {
      text: 'By checking this box and clicking "Get My Free Quote", I provide my electronic signature and express written consent for Final Expense Coverage to contact me.',
      version: "fec-tcpa-2026-09-18",
      timestamp: "2026-09-20T14:05:11.000Z",
    },
    audit: {
      ipAddress: "198.51.100.23",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  };

  return { ...(payload as unknown as Record<string, unknown>), ...overrides };
}

/** The `answers` object of the valid payload, with some fields replaced. */
export function answersWith(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...(validFinalExpensePayload().answers as object), ...changes };
}
