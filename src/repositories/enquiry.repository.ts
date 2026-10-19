import type { PoolClient, QueryResultRow } from "pg";

import { pool } from "@/db/pool";
import {
  ENQUIRY_PRIORITIES,
  ENQUIRY_STATUSES,
  type Assignee,
  type CreateEnquiry,
  type Enquiry,
  type EnquiryFacets,
  type EnquiryPriority,
  type EnquirySortField,
  type EnquiryStats,
  type EnquiryStatsQuery,
  type EnquiryStatus,
  type ListEnquiriesQuery,
} from "@/domain/enquiry.schema";

/**
 * Data access for enquiries. SQL lives here and nowhere else — the service
 * layer never sees a query string, so the persistence choice stays swappable
 * and the tests above this layer never need a database.
 */

/** A pool or a client already inside a transaction. */
export type Db = Pick<PoolClient, "query">;

function run<T extends QueryResultRow>(db: Db | undefined, text: string, params: unknown[] = []) {
  return (db ?? pool).query<T>(text, params);
}

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
  priority: EnquiryPriority;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  assigned_at: Date | null;
  last_contact_at: Date | null;
  next_follow_up_at: Date | null;
  source: string;
  created_at: Date;
  updated_at: Date;
}

const BASE_COLUMNS = `
  id, reference, name, email, phone, destination, visa_type, travel_month,
  message, consent, consented_at, status, priority, assigned_to_id,
  assigned_to_name, assigned_at, last_contact_at, source, created_at, updated_at
`;

/** Derived, never stored: a stored copy would drift every time a follow-up changed. */
const NEXT_FOLLOW_UP = `
  (SELECT MIN(f.due_at) FROM enquiry_follow_ups f
    WHERE f.enquiry_id = enquiries.id AND NOT f.completed) AS next_follow_up_at
`;

const SELECT_COLUMNS = `${BASE_COLUMNS}, ${NEXT_FOLLOW_UP}`;

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
    priority: row.priority,
    assignedTo:
      row.assigned_to_id !== null && row.assigned_to_name !== null
        ? { id: row.assigned_to_id, name: row.assigned_to_name }
        : null,
    assignedAt: row.assigned_at,
    lastContactAt: row.last_contact_at,
    nextFollowUpAt: row.next_follow_up_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Postgres's unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = "23505";

/** Rank expressions, so pipeline and priority sort in business order rather than alphabetically. */
const STATUS_RANK = `CASE status ${ENQUIRY_STATUSES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} END`;
const PRIORITY_RANK = `CASE priority ${ENQUIRY_PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(" ")} END`;

/**
 * Sort keys map onto a fixed set of expressions. The client picks a key, never
 * a column — interpolating a caller-supplied identifier is SQL injection by
 * another name.
 */
const SORT_EXPRESSIONS: Record<EnquirySortField, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  lastContactAt: "last_contact_at",
  nextFollowUpAt: "next_follow_up_at",
  name: "LOWER(name)",
  destination: "LOWER(destination)",
  visaType: "LOWER(visa_type)",
  status: STATUS_RANK,
  priority: PRIORITY_RANK,
};

type FilterInput = Partial<
  Pick<ListEnquiriesQuery, "status" | "priority" | "assignedTo" | "destination" | "visaType" | "q" | "from" | "to">
>;

/**
 * The WHERE clause shared by the list and the stats, built from bound
 * parameters only. `to` covers its whole day when given as a bare date, which
 * is how a date-range picker means it.
 */
function buildFilters(filters: FilterInput) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.status) clauses.push(`status = ${bind(filters.status)}`);
  if (filters.priority) clauses.push(`priority = ${bind(filters.priority)}`);
  if (filters.assignedTo === "unassigned") clauses.push("assigned_to_id IS NULL");
  else if (filters.assignedTo) clauses.push(`assigned_to_id = ${bind(filters.assignedTo)}`);
  if (filters.destination) clauses.push(`destination = ${bind(filters.destination)}`);
  if (filters.visaType) clauses.push(`visa_type = ${bind(filters.visaType)}`);
  if (filters.from) clauses.push(`created_at >= ${bind(filters.from)}`);
  if (filters.to) {
    const to = new Date(filters.to);
    const isBareDate =
      to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0 && to.getUTCMilliseconds() === 0;
    if (isBareDate) {
      to.setUTCDate(to.getUTCDate() + 1);
      clauses.push(`created_at < ${bind(to)}`);
    } else {
      clauses.push(`created_at <= ${bind(to)}`);
    }
  }
  if (filters.q) {
    /* POSITION rather than ILIKE. A LIKE pattern would need the operator's
       term escaped first — otherwise a search for "50%" matches every row and
       "a_b" matches "axb". POSITION has no metacharacters, so there is no
       escaping step to get wrong. Both sides are lowered, which is also what
       makes an uppercase reference like EVC-4K2P9X findable in lower case. */
    const term = bind(filters.q.toLowerCase());
    clauses.push(`(
         POSITION(${term} IN LOWER(reference))   > 0
      OR POSITION(${term} IN LOWER(name))        > 0
      OR POSITION(${term} IN LOWER(email))       > 0
      OR POSITION(${term} IN LOWER(COALESCE(phone, ''))) > 0
      OR POSITION(${term} IN LOWER(destination)) > 0
      OR POSITION(${term} IN LOWER(visa_type))   > 0
      OR POSITION(${term} IN LOWER(message))     > 0)`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params, bind };
}

/** One assignment change, with who held the enquiry before. */
export interface AssignmentChange {
  id: number;
  name: string;
  previous: Assignee | null;
}

export interface EnquiryRepository {
  create(input: CreateEnquiry & { reference: string }, db?: Db): Promise<Enquiry>;
  findById(id: number, db?: Db): Promise<Enquiry | null>;
  findByReference(reference: string): Promise<Enquiry | null>;
  list(params: ListEnquiriesQuery): Promise<{ items: Enquiry[]; total: number }>;
  stats(params?: EnquiryStatsQuery): Promise<EnquiryStats>;
  facets(): Promise<EnquiryFacets>;
  update(
    id: number,
    patch: { status?: EnquiryStatus; priority?: EnquiryPriority },
    db?: Db,
  ): Promise<Enquiry | null>;
  /** Sets the owner of every listed enquiry, returning only rows that actually changed. */
  assign(ids: number[], assignee: Assignee | null, db?: Db): Promise<AssignmentChange[]>;
  /** The ids from `ids` that exist. */
  existing(ids: number[], db?: Db): Promise<number[]>;
  touchLastContact(id: number, db?: Db): Promise<Enquiry | null>;
  purgeOlderThan(days: number): Promise<number>;
}

export const enquiryRepository: EnquiryRepository = {
  async create(input, db) {
    /* The enquiry and its "created" activity in one statement, so a timeline
       can never be missing its first entry — no transaction to forget. */
    const { rows } = await run<EnquiryRow>(
      db,
      `WITH inserted AS (
         INSERT INTO enquiries
           (reference, name, email, phone, destination, visa_type, travel_month,
            message, consent, consented_at, client_hash, user_agent, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12)
         RETURNING ${BASE_COLUMNS}
       ), activity AS (
         INSERT INTO enquiry_activities (enquiry_id, type, description, created_at)
         SELECT id, 'created', 'Enquiry received from ' || source, created_at FROM inserted
       )
       SELECT *, NULL::timestamptz AS next_follow_up_at FROM inserted`,
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

  async findById(id, db) {
    const { rows } = await run<EnquiryRow>(db, `SELECT ${SELECT_COLUMNS} FROM enquiries WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  async findByReference(reference) {
    const { rows } = await run<EnquiryRow>(
      undefined,
      `SELECT ${SELECT_COLUMNS} FROM enquiries WHERE reference = $1`,
      [reference],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  async list(query) {
    const { where, params, bind } = buildFilters(query);
    const direction = query.order === "asc" ? "ASC" : "DESC";
    const limit = bind(query.limit);
    const offset = bind(query.offset);

    /* Count and page in one round trip via a window function. Two separate
       queries would also be correct, but they can disagree if a row is
       inserted between them — a paginator that reports 21 results and returns
       20 is a support ticket. The derived follow-up column is sortable, so the
       ordering runs over a subquery that has already computed it. Empty
       values always sink, whichever way the list is sorted. */
    const { rows } = await run<EnquiryRow & { total_count: string }>(
      undefined,
      `SELECT *, COUNT(*) OVER () AS total_count
         FROM (SELECT ${SELECT_COLUMNS} FROM enquiries ${where}) AS enquiries
        ORDER BY ${SORT_EXPRESSIONS[query.sort]} ${direction} NULLS LAST, id ${direction}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return {
      items: rows.map(toEnquiry),
      // No rows means no matches — the window function has nothing to report.
      total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    };
  },

  /**
   * Dashboard counts.
   *
   * Every figure is computed over the same filtered set, so tiles always sum
   * to their own total. Grouped scans rather than a query per status: separate
   * COUNTs can disagree with each other, and a dashboard whose tiles do not add
   * up looks broken even when each number was right when it was read.
   */
  async stats(query = {}) {
    const { where, params } = buildFilters(query);
    const scoped = `SELECT * FROM enquiries ${where}`;

    const [summary, byStatus, byPriority, byDestination, byVisaType, byAssignee, monthly, followUps] =
      await Promise.all([
        run<{ total: string; assigned: string; last7: string; prev7: string }>(
          undefined,
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE assigned_to_id IS NOT NULL) AS assigned,
                  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last7,
                  COUNT(*) FILTER (WHERE created_at <  NOW() - INTERVAL '7 days'
                                     AND created_at >= NOW() - INTERVAL '14 days') AS prev7
             FROM (${scoped}) e`,
          params,
        ),
        run<{ status: EnquiryStatus; count: string }>(
          undefined,
          `SELECT status, COUNT(*) AS count FROM (${scoped}) e GROUP BY status`,
          params,
        ),
        run<{ priority: EnquiryPriority; count: string }>(
          undefined,
          `SELECT priority, COUNT(*) AS count FROM (${scoped}) e GROUP BY priority`,
          params,
        ),
        run<{ key: string; total: string; converted: string }>(
          undefined,
          `SELECT destination AS key, COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status = 'converted') AS converted
             FROM (${scoped}) e GROUP BY destination ORDER BY total DESC, destination LIMIT 20`,
          params,
        ),
        run<{ key: string; total: string; converted: string }>(
          undefined,
          `SELECT visa_type AS key, COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status = 'converted') AS converted
             FROM (${scoped}) e GROUP BY visa_type ORDER BY total DESC, visa_type LIMIT 20`,
          params,
        ),
        /* Grouped by id, with the most recently stored name: a rename in the
           CRM should not split one rep into two rows. */
        run<{ id: string; name: string; total: string; contacted: string; converted: string; lost: string }>(
          undefined,
          `SELECT assigned_to_id AS id,
                  (ARRAY_AGG(assigned_to_name ORDER BY assigned_at DESC NULLS LAST))[1] AS name,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status <> 'new') AS contacted,
                  COUNT(*) FILTER (WHERE status = 'converted') AS converted,
                  COUNT(*) FILTER (WHERE status = 'lost') AS lost
             FROM (${scoped}) e
            WHERE assigned_to_id IS NOT NULL
            GROUP BY assigned_to_id
            ORDER BY converted DESC, total DESC`,
          params,
        ),
        /* Bucketed in UTC inside SQL. `date_trunc` alone follows the session
           time zone, so on a server not set to UTC an enquiry from the last
           evening of a month would be counted in the next one. */
        run<{ month: string; total: string; converted: string }>(
          undefined,
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status = 'converted') AS converted
             FROM (${scoped}) e GROUP BY 1 ORDER BY 1`,
          params,
        ),
        run<{ count: string }>(
          undefined,
          `SELECT COUNT(*) AS count FROM enquiry_follow_ups f
             JOIN (${scoped}) e ON e.id = f.enquiry_id
            WHERE NOT f.completed`,
          params,
        ),
      ]);

    /* Seeded at zero. GROUP BY only returns keys that have rows, so without
       this a quiet week renders as missing tiles rather than tiles reading "0". */
    const statusCounts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0])) as Record<EnquiryStatus, number>;
    for (const row of byStatus.rows) statusCounts[row.status] = Number(row.count);
    const priorityCounts = Object.fromEntries(ENQUIRY_PRIORITIES.map((p) => [p, 0])) as Record<
      EnquiryPriority,
      number
    >;
    for (const row of byPriority.rows) priorityCounts[row.priority] = Number(row.count);

    const s = summary.rows[0]!;
    const total = Number(s.total);
    const assigned = Number(s.assigned);

    return {
      total,
      byStatus: statusCounts,
      byPriority: priorityCounts,
      assigned,
      unassigned: total - assigned,
      last7Days: Number(s.last7),
      previous7Days: Number(s.prev7),
      openFollowUps: Number(followUps.rows[0]?.count ?? 0),
      byDestination: byDestination.rows.map((r) => ({
        destination: r.key,
        total: Number(r.total),
        converted: Number(r.converted),
      })),
      byVisaType: byVisaType.rows.map((r) => ({
        visaType: r.key,
        total: Number(r.total),
        converted: Number(r.converted),
      })),
      byAssignee: byAssignee.rows.map((r) => ({
        assignedTo: { id: r.id, name: r.name },
        total: Number(r.total),
        contacted: Number(r.contacted),
        converted: Number(r.converted),
        lost: Number(r.lost),
      })),
      monthly: fillMonths(
        monthly.rows.map((r) => ({ month: r.month, total: Number(r.total), converted: Number(r.converted) })),
        query.from,
        query.to,
      ),
    };
  },

  async facets() {
    const [destinations, visaTypes] = await Promise.all([
      run<{ value: string }>(undefined, "SELECT DISTINCT destination AS value FROM enquiries ORDER BY 1"),
      run<{ value: string }>(undefined, "SELECT DISTINCT visa_type AS value FROM enquiries ORDER BY 1"),
    ]);
    return {
      destinations: destinations.rows.map((r) => r.value),
      visaTypes: visaTypes.rows.map((r) => r.value),
    };
  },

  async update(id, patch, db) {
    const { rows } = await run<EnquiryRow>(
      db,
      `UPDATE enquiries
          SET status   = COALESCE($2, status),
              priority = COALESCE($3, priority)
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id, patch.status ?? null, patch.priority ?? null],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  async assign(ids, assignee, db) {
    /* The previous owner is read in the same statement that replaces it, under
       a row lock, so two admins reassigning at once cannot both record
       "reassigned from" the same person. Rows already owned by the target are
       skipped: re-assigning to the current owner is not an event. */
    const { rows } = await run<{
      id: string;
      name: string;
      prev_id: string | null;
      prev_name: string | null;
    }>(
      db,
      `WITH previous AS (
         SELECT id, assigned_to_id AS prev_id, assigned_to_name AS prev_name
           FROM enquiries
          WHERE id = ANY($1::bigint[])
            AND assigned_to_id IS DISTINCT FROM $2::varchar
          FOR UPDATE
       )
       UPDATE enquiries e
          SET assigned_to_id   = $2,
              assigned_to_name = $3,
              assigned_at      = CASE WHEN $2::varchar IS NULL THEN NULL ELSE NOW() END
         FROM previous p
        WHERE e.id = p.id
        RETURNING e.id, e.name, p.prev_id, p.prev_name`,
      [ids, assignee?.id ?? null, assignee?.name ?? null],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      previous: r.prev_id !== null && r.prev_name !== null ? { id: r.prev_id, name: r.prev_name } : null,
    }));
  },

  async existing(ids, db) {
    const { rows } = await run<{ id: string }>(db, "SELECT id FROM enquiries WHERE id = ANY($1::bigint[])", [ids]);
    return rows.map((r) => Number(r.id));
  },

  async touchLastContact(id, db) {
    const { rows } = await run<EnquiryRow>(
      db,
      `UPDATE enquiries SET last_contact_at = NOW() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id],
    );
    const row = rows[0];
    return row ? toEnquiry(row) : null;
  },

  /**
   * Retention. UK GDPR Art. 5(1)(e) — personal data may not be kept longer
   * than necessary, and a stated retention period the business does not
   * enforce is worse than none. Lost leads are the dead ones; converted leads
   * are customers and are kept. Notes, activity and follow-ups go with the
   * enquiry through ON DELETE CASCADE.
   */
  async purgeOlderThan(days) {
    const { rowCount } = await run(
      undefined,
      `DELETE FROM enquiries
        WHERE created_at < NOW() - ($1 || ' days')::interval
          AND status = 'lost'`,
      [String(days)],
    );
    return rowCount ?? 0;
  },
};

/**
 * One entry per UTC month from the first month in range to the last, zeros
 * included, as `YYYY-MM`; `rows` are keyed the same way. Without a `from` the range is the six months ending
 * at `to` (or now), so an idle month renders as a bar of zero rather than
 * vanishing from the axis.
 */
export function fillMonths(
  rows: { month: string; total: number; converted: number }[],
  from?: Date,
  to?: Date,
): { month: string; total: number; converted: number }[] {
  const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const byKey = new Map(rows.map((r) => [r.month, r]));

  const end = to ?? new Date();
  const start = from ?? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const result: { month: string; total: number; converted: number }[] = [];
  // Capped so an absurd range cannot produce an absurd payload.
  while (cursor <= last && result.length < 36) {
    const k = key(cursor);
    const row = byKey.get(k);
    result.push({ month: k, total: row?.total ?? 0, converted: row?.converted ?? 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}
