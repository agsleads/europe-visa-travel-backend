import {
  toCreateLead,
  type Lead,
  type LeadDetail,
  type LeadStats,
  type LeadStatus,
  type LeadWebhook,
  type ListLeadsQuery,
} from "@/domain/lead.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { leadRepository, type LeadRepository } from "@/repositories/lead.repository";

/**
 * Business logic for Road Cover leads.
 *
 * The repository is injected so every rule here is unit-testable against a fake
 * with no database in the test run, exactly as the enquiry service is.
 */
export function createLeadService(repository: LeadRepository = leadRepository) {
  return {
    /**
     * Record a submission from the Road Cover site.
     *
     * Returns `duplicate: true` when the dedupe key was already present, which
     * the route turns into a 200 rather than a 201. The producer treats any
     * non-2xx as failure and shows the consumer a retry, so a replayed webhook
     * must succeed quietly instead of erroring -- a retry cannot fix a
     * duplicate, it can only create another one.
     *
     * `rawBody` is the untouched request body, stored verbatim. It is passed
     * separately from `payload` because `payload` is the *parsed* value, which
     * has already dropped unknown keys and truncated over-long audit strings.
     */
    async record(payload: LeadWebhook, rawBody: unknown): Promise<{ lead: Lead; duplicate: boolean }> {
      const input = toCreateLead(payload, rawBody);

      try {
        const { lead, duplicate } = await repository.create(input);

        /* Identifiers and non-personal context only. This payload carries a
           name, a phone number and a consent record; none of it belongs in a
           retained log store or a third-party error tracker. */
        logger.info(
          {
            leadId: lead.id,
            duplicate,
            stateFromZip: lead.stateFromZip,
            consentVersion: payload.consent.version,
          },
          duplicate ? "Road Cover lead already recorded" : "Road Cover lead stored",
        );

        return { lead, duplicate };
      } catch (error) {
        throw new AppError("Could not save the lead.", {
          status: 503,
          code: "storage_unavailable",
          cause: error,
        });
      }
    },

    async getById(id: number): Promise<LeadDetail> {
      const lead = await repository.findById(id);
      if (!lead) throw new NotFoundError(`No lead with id ${id}.`);
      return lead;
    },

    async list(params: ListLeadsQuery) {
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

    async stats(): Promise<LeadStats> {
      return repository.stats();
    },

    async updateStatus(id: number, status: LeadStatus): Promise<Lead> {
      const updated = await repository.updateStatus(id, status);
      if (!updated) throw new NotFoundError(`No lead with id ${id}.`);
      logger.info({ leadId: id, status }, "Road Cover lead status updated");
      return updated;
    },
  };
}

export type LeadService = ReturnType<typeof createLeadService>;
