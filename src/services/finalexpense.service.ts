import {
  toCreateFinalExpenseLead,
  type FinalExpenseLead,
  type FinalExpenseLeadDetail,
  type FinalExpenseLeadStats,
  type FinalExpenseWebhook,
  type ListFinalExpenseLeadsQuery,
} from "@/domain/finalexpense.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  finalExpenseLeadRepository,
  type FinalExpenseLeadRepository,
} from "@/repositories/finalexpense.repository";

/**
 * Business logic for Final Expense Coverage leads.
 *
 * The repository is injected so every rule here is unit-testable against a fake
 * with no database in the test run, exactly as the enquiry and Road Cover
 * services are.
 */
export function createFinalExpenseService(
  repository: FinalExpenseLeadRepository = finalExpenseLeadRepository,
) {
  return {
    /**
     * Record a submission from the Final Expense site.
     *
     * Returns `duplicate: true` when the dedupe key was already present, which
     * the route turns into a 200 rather than a 201. The site shows the visitor
     * an error on any non-2xx and invites a retry, so a repeated submission must
     * succeed quietly instead of erroring -- a retry cannot fix a duplicate, it
     * can only create another one.
     *
     * `rawBody` is the untouched request body, stored verbatim. It is passed
     * separately from `payload` because `payload` is the *parsed* value, which
     * has already dropped unknown keys and truncated over-long audit strings.
     */
    async record(
      payload: FinalExpenseWebhook,
      rawBody: unknown,
    ): Promise<{ lead: FinalExpenseLead; duplicate: boolean }> {
      const input = toCreateFinalExpenseLead(payload, rawBody);

      try {
        const { lead, duplicate } = await repository.create(input);

        /* Identifiers and non-personal context only. This payload carries a
           name, a phone number, a date of birth and a consent record; none of it
           belongs in a retained log store or a third-party error tracker. */
        logger.info(
          { leadId: lead.id, duplicate, source: payload.source, consentVersion: payload.consent.version },
          duplicate ? "Final Expense lead already recorded" : "Final Expense lead stored",
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

    async getById(id: number): Promise<FinalExpenseLeadDetail> {
      const lead = await repository.findById(id);
      if (!lead) throw new NotFoundError(`No lead with id ${id}.`);
      return lead;
    },

    async list(params: ListFinalExpenseLeadsQuery) {
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

    async stats(): Promise<FinalExpenseLeadStats> {
      return repository.stats();
    },
  };
}

export type FinalExpenseService = ReturnType<typeof createFinalExpenseService>;
