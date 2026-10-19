import {
  ENQUIRY_PRIORITIES,
  ENQUIRY_STATUSES,
  type Actor,
  type CreateEnquiry,
  type Enquiry,
  type EnquiryActivity,
  type EnquiryFollowUp,
  type EnquiryNote,
  type EnquiryPriority,
  type EnquiryStatus,
  type ListEnquiriesQuery,
} from "@/domain/enquiry.schema";
import { fillMonths, type EnquiryRepository } from "@/repositories/enquiry.repository";
import type { EnquiryCrmRepository } from "@/repositories/enquiryCrm.repository";
import type { EnquiryServiceDeps } from "@/services/enquiry.service";

/**
 * In-memory repository with the same contract as the Postgres one, including
 * the unique-reference constraint — the collision-retry path in the service is
 * only meaningfully testable if the fake actually rejects duplicates.
 */
export function createFakeRepository(): EnquiryRepository & { rows: Enquiry[]; failNext?: Error } {
  const rows: Enquiry[] = [];
  let nextId = 1;

  const byId = (id: number) => rows.find((r) => r.id === id) ?? null;
  /* Copies, as Postgres returns fresh rows: handing out the live object would
     let a later update rewrite a "before" snapshot the service compares against. */
  const copy = (row: Enquiry | null) => (row ? { ...row } : null);

  /** Mirrors the SQL filters: same columns, same case-insensitive substring match. */
  const matches = (r: Enquiry, q: Partial<ListEnquiriesQuery>) => {
    const needle = q.q?.toLowerCase();
    if (q.status && r.status !== q.status) return false;
    if (q.priority && r.priority !== q.priority) return false;
    if (q.assignedTo === "unassigned" && r.assignedTo) return false;
    if (q.assignedTo && q.assignedTo !== "unassigned" && r.assignedTo?.id !== q.assignedTo) return false;
    if (q.destination && r.destination !== q.destination) return false;
    if (q.visaType && r.visaType !== q.visaType) return false;
    if (q.from && r.createdAt < q.from) return false;
    if (q.to && r.createdAt > q.to) return false;
    if (
      needle &&
      ![r.reference, r.name, r.email, r.phone ?? "", r.destination, r.visaType, r.message].some((field) =>
        field.toLowerCase().includes(needle),
      )
    ) {
      return false;
    }
    return true;
  };

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
        priority: "medium",
        assignedTo: null,
        assignedAt: null,
        lastContactAt: null,
        nextFollowUpAt: null,
        source: input.source,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(enquiry);
      return enquiry;
    },

    async findById(id) {
      return copy(byId(id));
    },

    async findByReference(reference) {
      return rows.find((r) => r.reference === reference) ?? null;
    },

    async list(query: ListEnquiriesQuery) {
      const { limit, offset } = query;
      const matched = rows
        .filter((r) => matches(r, query))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
      return { items: matched.slice(offset, offset + limit), total: matched.length };
    },

    async stats(query = {}) {
      const scoped = rows.filter((r) => matches(r, query));
      const byStatus = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0])) as Record<EnquiryStatus, number>;
      const byPriority = Object.fromEntries(ENQUIRY_PRIORITIES.map((p) => [p, 0])) as Record<
        EnquiryPriority,
        number
      >;
      for (const row of scoped) {
        byStatus[row.status] += 1;
        byPriority[row.priority] += 1;
      }
      const now = Date.now();
      const assigned = scoped.filter((r) => r.assignedTo).length;
      return {
        total: scoped.length,
        byStatus,
        byPriority,
        assigned,
        unassigned: scoped.length - assigned,
        last7Days: scoped.filter((r) => r.createdAt.getTime() >= now - 7 * 86_400_000).length,
        previous7Days: scoped.filter(
          (r) => r.createdAt.getTime() < now - 7 * 86_400_000 && r.createdAt.getTime() >= now - 14 * 86_400_000,
        ).length,
        openFollowUps: 0,
        byDestination: [],
        byVisaType: [],
        byAssignee: [],
        monthly: fillMonths([], query.from, query.to),
      };
    },

    async facets() {
      return {
        destinations: [...new Set(rows.map((r) => r.destination))].sort(),
        visaTypes: [...new Set(rows.map((r) => r.visaType))].sort(),
      };
    },

    async update(id, patch) {
      const row = byId(id);
      if (!row) return null;
      if (patch.status) row.status = patch.status;
      if (patch.priority) row.priority = patch.priority;
      row.updatedAt = new Date();
      return copy(row);
    },

    async assign(ids, assignee) {
      const changes = [];
      for (const row of rows.filter((r) => ids.includes(r.id))) {
        if ((row.assignedTo?.id ?? null) === (assignee?.id ?? null)) continue;
        changes.push({ id: row.id, name: row.name, previous: row.assignedTo });
        row.assignedTo = assignee;
        row.assignedAt = assignee ? new Date() : null;
      }
      return changes;
    },

    async existing(ids) {
      return rows.filter((r) => ids.includes(r.id)).map((r) => r.id);
    },

    async touchLastContact(id) {
      const row = byId(id);
      if (!row) return null;
      row.lastContactAt = new Date();
      return row;
    },

    async purgeOlderThan(days: number) {
      const cutoff = Date.now() - days * 86_400_000;
      const doomed = rows.filter((r) => r.createdAt.getTime() < cutoff && r.status === "lost");
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return doomed.length;
    },
  };

  return fake;
}

/** In-memory activity, notes and follow-ups, with the Postgres repository's contract. */
export function createFakeCrmRepository(): EnquiryCrmRepository & {
  activities: EnquiryActivity[];
  notes: EnquiryNote[];
  followUps: EnquiryFollowUp[];
} {
  const activities: EnquiryActivity[] = [];
  const notes: EnquiryNote[] = [];
  const followUps: EnquiryFollowUp[] = [];
  let nextId = 1;
  const newest = <T extends { createdAt: Date; id: number }>(a: T, b: T) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;

  return {
    activities,
    notes,
    followUps,

    async addActivities(entries) {
      for (const entry of entries) {
        activities.push({
          id: nextId++,
          enquiryId: entry.enquiryId,
          type: entry.type,
          description: entry.description,
          actor: entry.actor,
          createdAt: new Date(),
        });
      }
    },
    async listActivities(enquiryId) {
      return activities.filter((a) => a.enquiryId === enquiryId).sort(newest);
    },
    async recentActivities({ limit }) {
      return [...activities].sort(newest).slice(0, limit);
    },

    async listNotes(enquiryId) {
      return notes.filter((n) => n.enquiryId === enquiryId).sort(newest);
    },
    async findNote(enquiryId, noteId) {
      return notes.find((n) => n.enquiryId === enquiryId && n.id === noteId) ?? null;
    },
    async createNote(enquiryId, content, author: Actor) {
      const now = new Date();
      const note = { id: nextId++, enquiryId, content, author, createdAt: now, updatedAt: now };
      notes.push(note);
      return note;
    },
    async updateNote(enquiryId, noteId, content) {
      const note = notes.find((n) => n.enquiryId === enquiryId && n.id === noteId);
      if (!note) return null;
      note.content = content;
      note.updatedAt = new Date();
      return note;
    },
    async deleteNote(enquiryId, noteId) {
      const index = notes.findIndex((n) => n.enquiryId === enquiryId && n.id === noteId);
      if (index === -1) return false;
      notes.splice(index, 1);
      return true;
    },

    async listFollowUps({ enquiryId, open, limit }) {
      return followUps
        .filter((f) => (enquiryId === undefined || f.enquiryId === enquiryId) && (!open || !f.completed))
        .sort((a, b) => Number(a.completed) - Number(b.completed) || a.dueAt.getTime() - b.dueAt.getTime())
        .slice(0, limit ?? 100);
    },
    async findFollowUp(enquiryId, followUpId) {
      const followUp = followUps.find((f) => f.enquiryId === enquiryId && f.id === followUpId);
      return followUp ? { ...followUp } : null;
    },
    async createFollowUp(enquiryId, { title, dueAt }, createdBy) {
      const followUp: EnquiryFollowUp = {
        id: nextId++,
        enquiryId,
        title,
        dueAt,
        completed: false,
        completedAt: null,
        createdBy,
        createdAt: new Date(),
      };
      followUps.push(followUp);
      return followUp;
    },
    async setFollowUpCompleted(enquiryId, followUpId, completed) {
      const followUp = followUps.find((f) => f.enquiryId === enquiryId && f.id === followUpId);
      if (!followUp) return null;
      followUp.completed = completed;
      followUp.completedAt = completed ? (followUp.completedAt ?? new Date()) : null;
      return followUp;
    },
    async deleteFollowUp(enquiryId, followUpId) {
      const index = followUps.findIndex((f) => f.enquiryId === enquiryId && f.id === followUpId);
      if (index === -1) return false;
      followUps.splice(index, 1);
      return true;
    },
  };
}

/** Service dependencies that never touch a database: fake CRM records and a pass-through transaction. */
export function fakeServiceDeps(crm = createFakeCrmRepository()): Required<EnquiryServiceDeps> {
  return {
    crm,
    transaction: (fn) => fn({ query: () => Promise.reject(new Error("Fakes never query.")) } as never),
  };
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
