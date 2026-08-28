import { env } from "@/config/env";
import type {
  CreateEnquiry,
  Enquiry,
  EnquiryStats,
  EnquiryStatus,
  ListEnquiriesQuery,
} from "@/domain/enquiry.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  enquiryRepository,
  UNIQUE_VIOLATION,
  type EnquiryRepository,
} from "@/repositories/enquiry.repository";
import { generateReference } from "@/services/reference";

/**
 * Business logic for enquiries.
 *
 * The repository is injected rather than imported directly so the service can
 * be unit-tested against a fake — every rule below is exercised without a
 * database anywhere near the test run.
 */
export function createEnquiryService(repository: EnquiryRepository = enquiryRepository) {
  return {
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
      const enquiry = await repository.findById(id);
      if (!enquiry) throw new NotFoundError(`No enquiry with id ${id}.`);
      return enquiry;
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

    /** Inbox counts for the admin dashboard. Reads nothing personal. */
    async stats(): Promise<EnquiryStats> {
      return repository.stats();
    },

    async updateStatus(id: number, status: EnquiryStatus): Promise<Enquiry> {
      const updated = await repository.updateStatus(id, status);
      if (!updated) throw new NotFoundError(`No enquiry with id ${id}.`);
      logger.info({ enquiryId: id, status }, "Enquiry status updated");
      return updated;
    },

    /** Retention purge. Intended to run from a scheduled job, not a request. */
    async purge(days: number = env.ENQUIRY_RETENTION_DAYS): Promise<number> {
      const deleted = await repository.purgeOlderThan(days);
      logger.info({ deleted, retentionDays: days }, "Retention purge complete");
      return deleted;
    },
  };
}

export type EnquiryService = ReturnType<typeof createEnquiryService>;
