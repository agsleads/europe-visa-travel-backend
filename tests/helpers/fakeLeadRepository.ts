import {
  type CreateLead,
  type Lead,
  type LeadDetail,
  type LeadStatus,
  type LeadWebhookInput,
} from "@/domain/lead.schema";
import type { CreateLeadResult, LeadRepository } from "@/repositories/lead.repository";

/**
 * In-memory lead repository with the same contract as the Postgres one,
 * including its idempotency on `dedupe_key` — the duplicate path in the route
 * is only meaningfully testable if the fake actually deduplicates.
 */

interface StoredLead extends Lead {
  dedupeKey: string;
  emailNormalised: string;
  rawPayload: unknown;
  consent: CreateLead["consent"];
  attribution: CreateLead["attribution"];
}

export function createFakeLeadRepository(): LeadRepository & {
  rows: StoredLead[];
  failNext?: Error;
} {
  const rows: StoredLead[] = [];
  let nextId = 1;

  const fake: LeadRepository & { rows: StoredLead[]; failNext?: Error } = {
    rows,

    async create(input: CreateLead): Promise<CreateLeadResult> {
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }

      const existing = rows.find((r) => r.dedupeKey === input.dedupeKey);
      if (existing) return { lead: existing, duplicate: true };

      const now = new Date();
      const lead: StoredLead = {
        id: nextId++,
        dedupeKey: input.dedupeKey,
        submittedAt: input.submittedAt,
        zip: input.zip,
        stateSelected: input.stateSelected,
        stateFromZip: input.stateFromZip,
        vehicleYear: input.vehicleYear,
        currentlyInsured: input.currentlyInsured,
        firstName: input.firstName,
        lastName: input.lastName,
        age: input.age,
        phoneRaw: input.phoneRaw,
        phoneE164: input.phoneE164,
        email: input.email,
        emailNormalised: input.emailNormalised,
        // Always 'new' — a client-supplied status must never reach the column.
        status: "new",
        createdAt: now,
        updatedAt: now,
        isRepeat: rows.some(
          (r) =>
            r.emailNormalised === input.emailNormalised ||
            (r.phoneE164 !== null && r.phoneE164 === input.phoneE164),
        ),
        rawPayload: input.rawPayload,
        consent: input.consent,
        attribution: input.attribution,
      };

      rows.push(lead);
      return { lead, duplicate: false };
    },

    async findById(id: number): Promise<LeadDetail | null> {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      return {
        ...row,
        rawPayload: row.rawPayload,
        relatedLeadIds: rows
          .filter(
            (r) =>
              r.id !== row.id &&
              (r.emailNormalised === row.emailNormalised ||
                (r.phoneE164 !== null && r.phoneE164 === row.phoneE164)),
          )
          .map((r) => r.id),
        consent: {
          text: row.consent.text,
          version: row.consent.version,
          consentedAt: row.consent.consentedAt,
          ipAddress: row.consent.ipAddress,
          userAgent: row.consent.userAgent,
          landingPageUrl: row.consent.landingPageUrl,
          trustedFormCertUrl: row.consent.trustedFormCertUrl,
        },
        attribution: { ...row.attribution },
      };
    },

    async list(params) {
      let items = [...rows].reverse();

      if (params.status) items = items.filter((r) => r.status === params.status);
      if (params.state) items = items.filter((r) => r.stateFromZip === params.state);
      if (params.currentlyInsured !== undefined) {
        items = items.filter((r) => r.currentlyInsured === params.currentlyInsured);
      }
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

      const total = items.length;
      return {
        items: items
          .slice(params.offset, params.offset + params.limit)
          .map((row) => ({
            ...row,
            utmSource: row.attribution.utmSource,
            utmCampaign: row.attribution.utmCampaign,
          })),
        total,
      };
    },

    async stats() {
      const byStatus = {
        new: 0,
        contacted: 0,
        sold: 0,
        rejected: 0,
        duplicate: 0,
      } as Record<LeadStatus, number>;
      for (const row of rows) byStatus[row.status] += 1;

      return {
        total: rows.length,
        today: rows.length,
        last7Days: rows.length,
        last30Days: rows.length,
        byStatus,
        byState: [],
        bySource: [],
      };
    },

    async updateStatus(id: number, status: LeadStatus) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = status;
      row.updatedAt = new Date();
      return row;
    },
  };

  return fake;
}

/**
 * A complete, valid webhook body — the worked example from the producer's own
 * BACKEND-PROMPT.md, so the fixture and the contract cannot drift apart
 * silently.
 *
 * `overrides` are merged at the top level only; the nested objects take a full
 * replacement, which keeps the helper honest about what a test is changing.
 */
export function validLeadPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload: LeadWebhookInput = {
    receivedAt: "2026-01-15T09:12:44.108Z",
    answers: {
      zip: "33131",
      state: "FL",
      vehicleYear: "2021",
      currentlyInsured: "yes",
      firstName: "Dana",
      lastName: "O'Neil",
      age: "34",
      phone: "(305) 555-0147",
      email: "dana@example.com",
    },
    state: "FL",
    consent: {
      text: 'By clicking "See My Auto Insurance Options," I provide my electronic signature and expressly consent to be contacted by Road Cover and/or its participating insurance providers.',
      version: "2026-01-v1",
      timestamp: "2026-01-15T09:12:43.900Z",
    },
    audit: {
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      landingPageUrl: "https://roadcover.us/?utm_source=google&utm_campaign=auto-fl",
      referrer: "https://www.google.com/",
      sessionId: "8f0c4e2a-1d3b-4c9a-9f21-7b5e0c6d8a44",
      formStartedAt: "2026-01-15T09:09:02.441Z",
      formCompletedAt: "2026-01-15T09:12:43.900Z",
      trustedFormCertUrl: null,
    },
    attribution: {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "auto-fl",
      utm_term: null,
      utm_content: null,
      gclid: "Cj0KCQabc123",
      fbclid: null,
    },
  };

  return { ...(payload as unknown as Record<string, unknown>), ...overrides };
}

/** The same submission with every nullable field actually null. */
export function minimalLeadPayload(): Record<string, unknown> {
  return validLeadPayload({
    state: null,
    audit: {
      ipAddress: null,
      userAgent: null,
      landingPageUrl: null,
      referrer: null,
      sessionId: "rc_m4x9k2_ab12cd",
      formStartedAt: null,
      formCompletedAt: "2026-01-15T09:12:43.900Z",
      trustedFormCertUrl: null,
    },
    attribution: {
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_term: null,
      utm_content: null,
      gclid: null,
      fbclid: null,
    },
  });
}
