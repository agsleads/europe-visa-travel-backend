import {
  ENQUIRY_STATUSES,
  type CreateEnquiry,
  type Enquiry,
  type EnquiryStatus,
  type ListEnquiriesQuery,
} from "@/domain/enquiry.schema";
import type { EnquiryRepository } from "@/repositories/enquiry.repository";

/**
 * In-memory repository with the same contract as the Postgres one, including
 * the unique-reference constraint — the collision-retry path in the service is
 * only meaningfully testable if the fake actually rejects duplicates.
 */
export function createFakeRepository(): EnquiryRepository & { rows: Enquiry[]; failNext?: Error } {
  const rows: Enquiry[] = [];
  let nextId = 1;

  const fake: EnquiryRepository & { rows: Enquiry[]; failNext?: Error } = {
    rows,

    async create(input) {
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }
      if (rows.some((r) => r.reference === input.reference)) {
        // Mirrors Postgres's unique-violation SQLSTATE, which is what the
        // service branches on.
        throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      }

      const now = new Date();
      const enquiry: Enquiry = {
        id: nextId++,
        reference: input.reference,
        name: input.name,
        email: input.email,
        phone: input.phone,
        destination: input.destination,
        visaType: input.visaType,
        travelMonth: input.travelMonth,
        message: input.message,
        consent: input.consent,
        consentedAt: now,
        status: "new",
        source: input.source,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(enquiry);
      return enquiry;
    },

    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },

    async findByReference(reference) {
      return rows.find((r) => r.reference === reference) ?? null;
    },

    async list({ status, q, limit, offset }: ListEnquiriesQuery) {
      /* Mirrors the SQL: the same columns, matched case-insensitively as a
         plain substring. A fake that searched different fields than the real
         query would let a wrong WHERE clause pass its own tests. */
      const needle = q?.toLowerCase();
      const matched = rows
        .filter((r) => !status || r.status === status)
        .filter(
          (r) =>
            !needle ||
            [r.reference, r.name, r.email, r.destination, r.message].some((field) =>
              field.toLowerCase().includes(needle),
            ),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
      return { items: matched.slice(offset, offset + limit), total: matched.length };
    },

    async stats() {
      const byStatus = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0])) as Record<
        EnquiryStatus,
        number
      >;
      const weekAgo = Date.now() - 7 * 86_400_000;

      for (const row of rows) byStatus[row.status] += 1;

      return {
        total: rows.length,
        byStatus,
        last7Days: rows.filter((r) => r.createdAt.getTime() >= weekAgo).length,
      };
    },

    async updateStatus(id: number, status: EnquiryStatus) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = status;
      row.updatedAt = new Date();
      return row;
    },

    async purgeOlderThan(days: number) {
      const cutoff = Date.now() - days * 86_400_000;
      const doomed = rows.filter(
        (r) => r.createdAt.getTime() < cutoff && (r.status === "closed" || r.status === "spam"),
      );
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return doomed.length;
    },
  };

  return fake;
}

/** A valid create payload; override any field to make it invalid on purpose. */
export function validEnquiryPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Aisha Rahman",
    email: "aisha@example.com",
    phone: "+44 20 7946 0958",
    destination: "France",
    visaType: "Tourism / visiting friends and family",
    travelMonth: "June 2026",
    message: "Travelling to Paris with my two children and unsure which consulate to apply to.",
    consent: true,
    ...overrides,
  };
}

export function toCreateEnquiry(overrides: Partial<CreateEnquiry> = {}): CreateEnquiry {
  return {
    name: "Aisha Rahman",
    email: "aisha@example.com",
    phone: "+44 20 7946 0958",
    destination: "France",
    visaType: "Tourism / visiting friends and family",
    travelMonth: "June 2026",
    message: "Travelling to Paris with my two children and unsure which consulate to apply to.",
    consent: true,
    source: "website",
    clientHash: null,
    userAgent: null,
    ...overrides,
  };
}
