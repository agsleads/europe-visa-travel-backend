import type { PoolClient } from "pg";

import { query } from "@/db/pool";
import {
  ENQUIRY_STATUSES,
  type CreateEnquiry,
  type Enquiry,
  type EnquiryStats,
  type EnquiryStatus,
  type ListEnquiriesQuery,
} from "@/domain/enquiry.schema";

/**
 * Data access for enquiries. SQL lives here and nowhere else — the service
 * layer never sees a query string, so the persistence choice stays swappable
 * and the tests above this layer never need a database.
 */

/** The row shape as Postgres returns it (snake_case). */
interface EnquiryRow {
  id: string; // BIGSERIAL arrives as a string; pg will not silently lose precision.
  reference: string;
  name: string;
  email: string;
  phone: string | null;
  destination: string;
  visa_type: string;
  travel_month: string;
  message: string;
  consent: boolean;
  consented_at: Date | null;
  status: EnquiryStatus;
  source: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, reference, name, email, phone, destination, visa_type, travel_month,
  message, consent, consented_at, status, source, created_at, updated_at
`;

function toEnquiry(row: EnquiryRow): Enquiry {
  return {
    id: Number(row.id),
    reference: row.reference,
    name: row.name,
    email: row.email,
    phone: row.phone,
    destination: row.destination,
    visaType: row.visa_type,
    travelMonth: row.travel_month,
    message: row.message,
    consent: row.consent,
    consentedAt: row.consented_at,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Postgres's unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = "23505";

export interface EnquiryRepository {
  create(input: CreateEnquiry & { reference: string }, client?: PoolClient): Promise<Enquiry>;
  findById(id: number): Promise<Enquiry | null>;
  findByReference(reference: string): Promise<Enquiry | null>;
  list(params: ListEnquiriesQuery): Promise<{ items: Enquiry[]; total: number }>;
  stats(): Promise<EnquiryStats>;
  updateStatus(id: number, status: EnquiryStatus): Promise<Enquiry | null>;
  purgeOlderThan(days: number): Promise<number>;
}

export const enquiryRepository: EnquiryRepository = {
  async create(input, client) {
    const run = client
      ? <T extends EnquiryRow>(text: string, params: unknown[]) => client.query<T>(text, params)
      : <T extends EnquiryRow>(text: string, params: unknown[]) => query<T>(text, params);

    const { rows } = await run<EnquiryRow>(
      `INSERT INTO enquiries
         (reference, name, email, phone, destination, visa_type, travel_month,
          message, consent, consented_at, client_hash, user_agent, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.reference,
        input.name,
        input.email,
        input.phone,
        input.destination,
        input.visaType,
        input.travelMonth,
        input.message,
        input.consent,
        input.clientHash,
        input.userAgent,
        input.source,
      ],
    );

    // RETURNING on a single-row INSERT always yields exactly one row; if it
    // somehow does not, that is a bug worth failing loudly on.
    const row = rows[0];
    if (!row) throw new Error("INSERT ... RETURNING produced no row.");
    return toEnquiry(row);
  },

  async findById(id) {
    const { rows } = await query<EnquiryRow>(
      `SELECT ${SELECT_COLUMNS} FROM enquiries WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  async findByReference(reference) {
    const { rows } = await query<EnquiryRow>(
      `SELECT ${SELECT_COLUMNS} FROM enquiries WHERE reference = $1`,
      [reference],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  async list({ status, q, limit, offset }) {
    /* Search uses POSITION rather than ILIKE. A LIKE pattern would need the
       operator's term escaped first — otherwise a search for "50%" matches
       every row and "a_b" matches "axb", so the filter quietly answers a
       different question than the one that was typed. POSITION has no
       metacharacters, so there is no escaping step to get wrong. Both sides
       are lowered, which is also what makes an uppercase reference like
       EVC-4K2P9X findable by typing it in lower case. */

    /* Count and page in one round trip via a window function. Two separate
       queries would also be correct, but they can disagree if a row is
       inserted between them — a paginator that reports 21 results and returns
       20 is a support ticket. */
    const { rows } = await query<EnquiryRow & { total_count: string }>(
      `SELECT ${SELECT_COLUMNS}, COUNT(*) OVER () AS total_count
         FROM enquiries
        WHERE ($1::text IS NULL OR status = $1)
          AND ($4::text IS NULL OR (
                POSITION($4 IN LOWER(reference))   > 0
             OR POSITION($4 IN LOWER(name))        > 0
             OR POSITION($4 IN LOWER(email))       > 0
             OR POSITION($4 IN LOWER(destination)) > 0
             OR POSITION($4 IN LOWER(message))     > 0))
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [status ?? null, limit, offset, q ? q.toLowerCase() : null],
    );

    return {
      items: rows.map(toEnquiry),
      // No rows means no matches — the window function has nothing to report.
      total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    };
  },

  /**
   * Dashboard counts, in one round trip.
   *
   * One grouped scan rather than a query per status: six sequential COUNTs
   * would also be correct but they can disagree with each other, and a
   * dashboard whose tiles do not sum to its own total looks broken even when
   * every number was individually right when it was read.
   */
  async stats() {
    const { rows } = await query<{ status: EnquiryStatus; count: string; recent: string }>(
      `SELECT status,
              COUNT(*) AS count,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS recent
         FROM enquiries
        GROUP BY status`,
    );

    /* Seeded with every status at zero. GROUP BY only returns statuses that
       have rows, so without this a quiet week renders as missing tiles rather
       than as tiles reading "0". */
    const byStatus = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0])) as Record<
      EnquiryStatus,
      number
    >;

    let total = 0;
    let last7Days = 0;
    for (const row of rows) {
      const count = Number(row.count);
      byStatus[row.status] = count;
      total += count;
      last7Days += Number(row.recent);
    }

    return { total, byStatus, last7Days };
  },

  async updateStatus(id, status) {
    const { rows } = await query<EnquiryRow>(
      `UPDATE enquiries SET status = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, status],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  /**
   * Retention. UK GDPR Art. 5(1)(e) — personal data may not be kept longer
   * than necessary, and a stated retention period the business does not
   * enforce is worse than none. This is the routine behind that promise.
   */
  async purgeOlderThan(days) {
    const { rowCount } = await query(
      `DELETE FROM enquiries
        WHERE created_at < NOW() - ($1 || ' days')::interval
          AND status IN ('closed', 'spam')`,
      [String(days)],
    );
    return rowCount ?? 0;
  },
};
