import type {
  CreateSeniorHealthLead,
  SeniorHealthLead,
  SeniorHealthLeadDetail,
  SeniorHealthWebhookInput,
} from "@/domain/seniorhealth.schema";
import type {
  CreateSeniorHealthLeadResult,
  SeniorHealthLeadRepository,
} from "@/repositories/seniorhealth.repository";

/**
 * In-memory Senior Health repository with the same contract as the Postgres
 * one, including its idempotency on `dedupe_key` -- the duplicate path in the
 * route is only meaningfully testable if the fake actually deduplicates.
 */

interface StoredLead extends SeniorHealthLead {
  dedupeKey: string;
  rawPayload: unknown;
  consent: CreateSeniorHealthLead["consent"];
}

export function createFakeSeniorHealthRepository(): SeniorHealthLeadRepository & {
  rows: StoredLead[];
  failNext?: Error;
} {
  const rows: StoredLead[] = [];
  let nextId = 1;

  const fake: SeniorHealthLeadRepository & { rows: StoredLead[]; failNext?: Error } = {
    rows,

    async create(input: CreateSeniorHealthLead): Promise<CreateSeniorHealthLeadResult> {
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
        zip: input.zip,
        state: input.state,
        createdAt: new Date(),
        /* Phone only, mirroring the SQL: this producer has no email, and the
           null guard is what stops two un-normalisable numbers matching. */
        isRepeat: rows.some((r) => r.phoneE164 !== null && r.phoneE164 === input.phoneE164),
        rawPayload: input.rawPayload,
        consent: input.consent,
      };

      rows.push(lead);
      return { lead, duplicate: false };
    },

    async findById(id: number): Promise<SeniorHealthLeadDetail | null> {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      return {
        ...row,
        relatedLeadIds: rows
          .filter((r) => r.id !== row.id && r.phoneE164 !== null && r.phoneE164 === row.phoneE164)
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
            r.zip.includes(needle) ||
            r.state.toLowerCase().includes(needle) ||
            (digits !== "" && r.phoneRaw.replace(/\D/g, "").includes(digits)),
        );
      }

      if (params.state) items = items.filter((r) => r.state === params.state);

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
 * A complete, valid request body, shaped exactly as the Senior Health Benefits
 * site's server route sends it.
 *
 * `overrides` are merged at the top level only; the nested objects take a full
 * replacement, which keeps the helper honest about what a test is changing.
 */
export function validSeniorHealthPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload: SeniorHealthWebhookInput = {
    submissionId: "8c2a41de-6f30-4b17-9a5e-77d0c3b9e214",
    receivedAt: "2026-09-23T15:20:44.000Z",
    source: "seniorhealthbenefits.net/#quote",
    answers: {
      firstName: "Dorothy",
      lastName: "Hale",
      phone: "(307) 555-0142",
      zip: "82601",
      state: "WY",
    },
    consent: {
      text: "By checking this box, I agree that Senior Health Benefits and its licensed insurance agents may contact me at the phone number I provided, including by calls and text messages that may use automated technology or prerecorded voices, about Medicare Advantage, Medicare Supplement, and Prescription Drug Plans. Message and data rates may apply. Consent is not a condition of purchase, and I can opt out at any time.",
      version: "shb-tcpa-2026-09-23",
      timestamp: "2026-09-23T15:20:41.000Z",
    },
    audit: {
      ipAddress: "198.51.100.23",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  };

  return { ...(payload as unknown as Record<string, unknown>), ...overrides };
}

/** The `answers` object of the valid payload, with some fields replaced. */
export function seniorHealthAnswersWith(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...(validSeniorHealthPayload().answers as object), ...changes };
}
