import { env } from "@/config/env";
import { withTransaction } from "@/db/pool";
import type {
  Actor,
  Assignee,
  ContactChannel,
  CreateEnquiry,
  Enquiry,
  EnquiryPriority,
  EnquiryStats,
  EnquiryStatsQuery,
  EnquiryStatus,
  ListEnquiriesQuery,
  ListFollowUpsQuery,
  RecentActivityQuery,
  UpdateEnquiry,
} from "@/domain/enquiry.schema";
import { SYSTEM_ACTOR } from "@/domain/enquiry.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  enquiryRepository,
  UNIQUE_VIOLATION,
  type Db,
  type EnquiryRepository,
} from "@/repositories/enquiry.repository";
import {
  enquiryCrmRepository,
  type EnquiryCrmRepository,
  type NewActivity,
} from "@/repositories/enquiryCrm.repository";
import { generateReference } from "@/services/reference";

const STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  converted: "Converted",
  lost: "Lost",
};

const PRIORITY_LABELS: Record<EnquiryPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const CONTACT_DESCRIPTIONS: Record<ContactChannel, string> = {
  call: "Call logged",
  email: "Email logged",
  whatsapp: "WhatsApp message logged",
};

export type Transaction = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

export interface EnquiryServiceDeps {
  crm?: EnquiryCrmRepository;
  /** Runs a unit of work atomically. Tests pass a pass-through. */
  transaction?: Transaction;
}

/**
 * Business logic for enquiries and the CRM work done on them.
 *
 * Repositories are injected rather than imported directly so the service can
 * be unit-tested against fakes — every rule below is exercised without a
 * database anywhere near the test run.
 */
export function createEnquiryService(
  repository: EnquiryRepository = enquiryRepository,
  { crm = enquiryCrmRepository, transaction = withTransaction }: EnquiryServiceDeps = {},
) {
  async function requireEnquiry(id: number, db?: Db): Promise<Enquiry> {
    const enquiry = await repository.findById(id, db);
    if (!enquiry) throw new NotFoundError(`No enquiry with id ${id}.`);
    return enquiry;
  }

  function assignmentActivity(
    change: { id: number; previous: Assignee | null },
    assignee: Assignee | null,
    actor: Actor,
  ): NewActivity {
    if (!assignee) {
      return {
        enquiryId: change.id,
        type: "unassigned",
        description: change.previous ? `Unassigned from ${change.previous.name}` : "Unassigned",
        actor,
      };
    }
    return {
      enquiryId: change.id,
      type: "assigned",
      description: change.previous
        ? `Reassigned from ${change.previous.name} to ${assignee.name}`
        : `Assigned to ${assignee.name}`,
      actor,
    };
  }

  const service = {
    /**
     * Persist a new enquiry.
     *
     * The reference is generated here and is subject to a birthday collision
     * (32^6 ≈ 1.07e9 values), so the unique index is treated as the authority
     * and a collision is retried rather than surfaced to the enquirer. Three
     * attempts makes the failure probability negligible at any realistic
     * volume while keeping a genuine constraint bug from looping forever.
     */
    async create(input: CreateEnquiry): Promise<Enquiry> {
      const MAX_ATTEMPTS = 3;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const reference = generateReference();
        try {
          const enquiry = await repository.create({ ...input, reference });
          // Identifiers only. The payload is personal data and must not reach
          // a retained log store.
          logger.info({ enquiryId: enquiry.id, reference: enquiry.reference }, "Enquiry stored");
          return enquiry;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === UNIQUE_VIOLATION && attempt < MAX_ATTEMPTS) {
            logger.warn({ attempt }, "Enquiry reference collision, regenerating");
            continue;
          }
          throw new AppError("Could not save the enquiry.", {
            status: 503,
            code: "storage_unavailable",
            cause: error,
          });
        }
      }

      /* Unreachable: the loop either returns or throws. Present so the
         function is total, rather than relying on control flow the type
         checker cannot see. */
      throw new AppError("Could not allocate a unique enquiry reference.", {
        status: 503,
        code: "reference_exhausted",
      });
    },

    async getById(id: number): Promise<Enquiry> {
      return requireEnquiry(id);
    },

    async getByReference(reference: string): Promise<Enquiry> {
      const enquiry = await repository.findByReference(reference);
      if (!enquiry) throw new NotFoundError(`No enquiry with reference ${reference}.`);
      return enquiry;
    },

    async list(params: ListEnquiriesQuery) {
      const { items, total } = await repository.list(params);
      return {
        items,
        pagination: {
          total,
          limit: params.limit,
          offset: params.offset,
          hasMore: params.offset + items.length < total,
        },
      };
    },

    /** Pipeline counts for the dashboards. Reads nothing personal. */
    async stats(query: EnquiryStatsQuery = {}): Promise<EnquiryStats> {
      return repository.stats(query);
    },

    async facets() {
      return repository.facets();
    },

    async updateStatus(id: number, status: EnquiryStatus, actor: Actor = SYSTEM_ACTOR): Promise<Enquiry> {
      return service.update(id, { status }, actor);
    },

    /** Status and/or priority, each change recorded as its own activity. */
    async update(id: number, patch: UpdateEnquiry, actor: Actor = SYSTEM_ACTOR): Promise<Enquiry> {
      const updated = await transaction(async (db) => {
        const before = await requireEnquiry(id, db);
        const after = (await repository.update(id, patch, db))!;

        const activities: NewActivity[] = [];
        if (patch.status && patch.status !== before.status) {
          activities.push({
            enquiryId: id,
            type: "status_changed",
            description: `Status changed from ${STATUS_LABELS[before.status]} to ${STATUS_LABELS[patch.status]}`,
            actor,
          });
        }
        if (patch.priority && patch.priority !== before.priority) {
          activities.push({
            enquiryId: id,
            type: "priority_changed",
            description: `Priority changed from ${PRIORITY_LABELS[before.priority]} to ${PRIORITY_LABELS[patch.priority]}`,
            actor,
          });
        }
        await crm.addActivities(activities, db);
        return after;
      });
      logger.info({ enquiryId: id, ...patch }, "Enquiry updated");
      return updated;
    },

    /** Assign, reassign, or (with `null`) unassign one enquiry. */
    async assign(id: number, assignee: Assignee | null, actor: Actor = SYSTEM_ACTOR): Promise<Enquiry> {
      const updated = await transaction(async (db) => {
        await requireEnquiry(id, db);
        const changes = await repository.assign([id], assignee, db);
        await crm.addActivities(
          changes.map((change) => assignmentActivity(change, assignee, actor)),
          db,
        );
        return requireEnquiry(id, db);
      });
      logger.info({ enquiryId: id, assignedTo: assignee?.id ?? null }, "Enquiry assignment updated");
      return updated;
    },

    /**
     * Assign many enquiries at once.
     *
     * Ids that do not exist are reported rather than failing the batch: in a
     * multi-select of fifty, one row deleted by the retention purge a moment
     * earlier should not undo the other forty-nine.
     */
    async bulkAssign(ids: number[], assignee: Assignee | null, actor: Actor = SYSTEM_ACTOR) {
      const result = await transaction(async (db) => {
        const found = await repository.existing(ids, db);
        const foundSet = new Set(found);
        const changes = found.length ? await repository.assign(found, assignee, db) : [];
        await crm.addActivities(
          changes.map((change) => assignmentActivity(change, assignee, actor)),
          db,
        );
        return {
          updated: changes.length,
          unchanged: found.length - changes.length,
          notFound: ids.filter((id) => !foundSet.has(id)),
        };
      });
      logger.info(
        { requested: ids.length, updated: result.updated, notFound: result.notFound.length },
        "Bulk assignment",
      );
      return result;
    },

    /** Records an outreach and stamps the enquiry's last-contact time. */
    async logContact(id: number, channel: ContactChannel, actor: Actor = SYSTEM_ACTOR): Promise<Enquiry> {
      return transaction(async (db) => {
        await requireEnquiry(id, db);
        await repository.touchLastContact(id, db);
        await crm.addActivities(
          [{ enquiryId: id, type: channel, description: CONTACT_DESCRIPTIONS[channel], actor }],
          db,
        );
        return requireEnquiry(id, db);
      });
    },

    async activities(id: number) {
      await requireEnquiry(id);
      return crm.listActivities(id);
    },

    async recentActivities(query: RecentActivityQuery) {
      return crm.recentActivities(query);
    },

    async notes(id: number) {
      await requireEnquiry(id);
      return crm.listNotes(id);
    },

    async addNote(id: number, content: string, actor: Actor = SYSTEM_ACTOR) {
      return transaction(async (db) => {
        await requireEnquiry(id, db);
        const note = await crm.createNote(id, content, actor, db);
        await crm.addActivities([{ enquiryId: id, type: "note_added", description: "Note added", actor }], db);
        return note;
      });
    },

    async updateNote(id: number, noteId: number, content: string) {
      const note = await crm.updateNote(id, noteId, content);
      if (!note) throw new NotFoundError(`No note ${noteId} on enquiry ${id}.`);
      return note;
    },

    async deleteNote(id: number, noteId: number) {
      if (!(await crm.deleteNote(id, noteId))) throw new NotFoundError(`No note ${noteId} on enquiry ${id}.`);
    },

    async followUps(id: number) {
      await requireEnquiry(id);
      return crm.listFollowUps({ enquiryId: id });
    },

    /** Follow-ups across enquiries, e.g. one rep's upcoming list. */
    async allFollowUps(query: ListFollowUpsQuery) {
      return crm.listFollowUps(query);
    },

    async addFollowUp(id: number, input: { title: string; dueAt: Date }, actor: Actor = SYSTEM_ACTOR) {
      return transaction(async (db) => {
        await requireEnquiry(id, db);
        const followUp = await crm.createFollowUp(id, input, actor, db);
        await crm.addActivities(
          [{ enquiryId: id, type: "follow_up_added", description: `Follow-up scheduled: ${followUp.title}`, actor }],
          db,
        );
        return followUp;
      });
    },

    async setFollowUpCompleted(id: number, followUpId: number, completed: boolean, actor: Actor = SYSTEM_ACTOR) {
      return transaction(async (db) => {
        const before = await crm.findFollowUp(id, followUpId, db);
        if (!before) throw new NotFoundError(`No follow-up ${followUpId} on enquiry ${id}.`);
        const after = (await crm.setFollowUpCompleted(id, followUpId, completed, db))!;
        // Only the transition to done is an event; re-ticking a done box is not.
        if (completed && !before.completed) {
          await crm.addActivities(
            [{ enquiryId: id, type: "follow_up_completed", description: `Follow-up completed: ${after.title}`, actor }],
            db,
          );
        }
        return after;
      });
    },

    async deleteFollowUp(id: number, followUpId: number) {
      if (!(await crm.deleteFollowUp(id, followUpId))) {
        throw new NotFoundError(`No follow-up ${followUpId} on enquiry ${id}.`);
      }
    },

    /** Retention purge. Intended to run from a scheduled job, not a request. */
    async purge(days: number = env.ENQUIRY_RETENTION_DAYS): Promise<number> {
      const deleted = await repository.purgeOlderThan(days);
      logger.info({ deleted, retentionDays: days }, "Retention purge complete");
      return deleted;
    },
  };

  return service;
}

export type EnquiryService = ReturnType<typeof createEnquiryService>;
