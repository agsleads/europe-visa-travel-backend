import { query, withTransaction } from "@/db/pool";
import type {
  CreateSeniorHealthLead,
  ListSeniorHealthLeadsQuery,
  SeniorHealthLead,
  SeniorHealthLeadDetail,
  SeniorHealthLeadStats,
} from "@/domain/seniorhealth.schema";

/**
 * Data access for Senior Health Benefits Medicare leads. SQL lives here and
 * nowhere else.
 *
 * Every write goes through one transaction covering both tables: a lead without
 * its consent record is not a partially-saved lead, it is a lead that cannot
 * lawfully be called. Saving one without the other is worse than saving neither.
 */

/* -------------------------------------------------------------------- rows */

interface LeadRow {
  id: string; // BIGSERIAL arrives as a string; pg will not silently lose precision.
  submitted_at: Date;
  source: string;
  first_name: string;
  last_name: string;
  phone_raw: string;
  phone_e164: string | null;
  zip: string;
  state: string;
  created_at: Date;
  is_repeat: boolean;
}

interface LeadDetailRow extends LeadRow {
  raw_payload: unknown;
  consent_text: string;
  consent_version: string;
  consented_at: Date;
  ip_address: string | null;
  user_agent: string | null;
}

/**
 * The lead columns, plus the repeat-submission flag.
 *
 * The repeat test is phone-only because this producer collects no email. The
 * `IS NOT NULL` guard matters more than it does on the other producers for the
 * same reason: it is the only key, and without the guard every lead whose
 * number could not be normalised would match every other such lead.
 */
const LEAD_COLUMNS = `
  l.id, l.submitted_at, l.source, l.first_name, l.last_name,
  l.phone_raw, l.phone_e164, l.zip, l.state, l.created_at,
  EXISTS (
    SELECT 1 FROM senior_health_leads earlier
     WHERE earlier.id < l.id
       AND earlier.phone_e164 IS NOT NULL
       AND earlier.phone_e164 = l.phone_e164
  ) AS is_repeat
`;

function toLead(row: LeadRow): SeniorHealthLead {
  return {
    id: Number(row.id),
    submittedAt: row.submitted_at,
    source: row.source,
    firstName: row.first_name,
    lastName: row.last_name,
    phoneRaw: row.phone_raw,
    phoneE164: row.phone_e164,
    zip: row.zip,
    state: row.state,
    createdAt: row.created_at,
    isRepeat: row.is_repeat,
  };
}

function toLeadDetail(row: LeadDetailRow, relatedLeadIds: number[]): SeniorHealthLeadDetail {
  return {
    ...toLead(row),
    rawPayload: row.raw_payload,
    relatedLeadIds,
    consent: {
      text: row.consent_text,
      version: row.consent_version,
      consentedAt: row.consented_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    },
  };
}

/** What a create attempt did, so the service can answer 201 or 200. */
export interface CreateSeniorHealthLeadResult {
  lead: SeniorHealthLead;
  /** True when the dedupe key already existed and nothing was written. */
  duplicate: boolean;
}

export interface SeniorHealthLeadRepository {
  create(input: CreateSeniorHealthLead): Promise<CreateSeniorHealthLeadResult>;
  findById(id: number): Promise<SeniorHealthLeadDetail | null>;
  list(params: ListSeniorHealthLeadsQuery): Promise<{ items: SeniorHealthLead[]; total: number }>;
  stats(): Promise<SeniorHealthLeadStats>;
}

export const seniorHealthLeadRepository: SeniorHealthLeadRepository = {
  /**
   * Writes the lead and its consent record in one transaction.
   *
   * Idempotent on `dedupe_key`. `ON CONFLICT DO NOTHING` rather than a
   * SELECT-then-INSERT: two concurrent retries of the same submission would both
   * pass a prior existence check and one would then fail on the unique index,
   * returning a 500 for what is a successful, already-recorded submission.
   */
  async create(input) {
    return withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO senior_health_leads
           (dedupe_key, submitted_at, source, first_name, last_name,
            phone_raw, phone_e164, zip, state, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [
          input.dedupeKey,
          input.submittedAt,
          input.source,
          input.firstName,
          input.lastName,
          input.phoneRaw,
          input.phoneE164,
          input.zip,
          input.state,
          JSON.stringify(input.rawPayload),
        ],
      );

      const row = inserted.rows[0];

      /* Conflict: this submission is already recorded. Return the original
         rather than writing a second consent row against it -- the consent
         table is append-only and one submission has exactly one consent. */
      if (!row) {
        const existing = await client.query<LeadRow>(
          `SELECT ${LEAD_COLUMNS} FROM senior_health_leads l WHERE l.dedupe_key = $1`,
          [input.dedupeKey],
        );
        const found = existing.rows[0];
        if (!found) {
          // The conflicting row vanished between the two statements, which
          // inside one transaction should not be possible.
          throw new Error("Lead conflicted on dedupe_key but could not be read back.");
        }
        return { lead: toLead(found), duplicate: true };
      }

      const leadId = row.id;

      await client.query(
        `INSERT INTO senior_health_lead_consents
           (lead_id, consent_text, consent_version, consented_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          leadId,
          input.consent.text,
          input.consent.version,
          input.consent.consentedAt,
          input.consent.ipAddress,
          input.consent.userAgent,
        ],
      );

      const saved = await client.query<LeadRow>(
        `SELECT ${LEAD_COLUMNS} FROM senior_health_leads l WHERE l.id = $1`,
        [leadId],
      );
      const savedRow = saved.rows[0];
      if (!savedRow) throw new Error("INSERT ... RETURNING produced no readable row.");

      return { lead: toLead(savedRow), duplicate: false };
    });
  },

  async findById(id) {
    const { rows } = await query<LeadDetailRow>(
      `SELECT ${LEAD_COLUMNS},
              l.raw_payload,
              c.consent_text, c.consent_version, c.consented_at,
              c.ip_address, c.user_agent
         FROM senior_health_leads l
         /* The consent is written in the same transaction as the lead, so an
            INNER JOIN would also match today. LEFT keeps a lead that somehow
            lost its consent row readable in the dashboard rather than
            invisible -- an operator who cannot see it cannot fix it. */
         LEFT JOIN senior_health_lead_consents c ON c.lead_id = l.id
        WHERE l.id = $1`,
      [id],
    );

    const row = rows[0];
    if (!row) return null;

    /* Earlier submissions from the same number, for the "seen before" link.
       Bounded: a number used by a call centre could otherwise return thousands
       of ids into a page that renders every one of them. */
    const related = await query<{ id: string }>(
      `SELECT id FROM senior_health_leads
        WHERE id <> $1
          AND phone_e164 IS NOT NULL
          AND phone_e164 = (SELECT phone_e164 FROM senior_health_leads WHERE id = $1)
        ORDER BY created_at DESC
        LIMIT 20`,
      [id],
    );

    return toLeadDetail(
      row,
      related.rows.map((r) => Number(r.id)),
    );
  },

  /**
   * A page of leads, newest first.
   *
   * Count and page come back together via a window function: two separate
   * queries can disagree if a row lands between them, and a paginator that
   * reports 26 results while returning 25 is a support ticket.
   */
  async list({ q, state, limit, offset }) {
    const { rows } = await query<LeadRow & { total_count: string }>(
      `SELECT ${LEAD_COLUMNS}, COUNT(*) OVER () AS total_count
         FROM senior_health_leads l
          /* POSITION, not ILIKE: a LIKE pattern would need the operator's term
             escaped first, or a search for "50%" matches every row. Phone search
             strips punctuation on both sides so "3075550142" finds a number
             stored as "(307) 555-0142". */
        WHERE ($1::text IS NULL OR (
                POSITION($1 IN LOWER(l.first_name)) > 0
             OR POSITION($1 IN LOWER(l.last_name)) > 0
             OR POSITION($1 IN LOWER(l.first_name || ' ' || l.last_name)) > 0
             OR POSITION($1 IN l.zip) > 0
             OR POSITION(UPPER($1) IN l.state) > 0
             OR ($2::text <> '' AND POSITION($2 IN REGEXP_REPLACE(l.phone_raw, '\\D', '', 'g')) > 0)))
          AND ($3::text IS NULL OR l.state = $3)
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $4 OFFSET $5`,
      [q ? q.toLowerCase() : null, q ? q.replace(/\D/g, "") : "", state ?? null, limit, offset],
    );

    return {
      items: rows.map(toLead),
      total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    };
  },

  /**
   * Overview counters in one grouped scan. Operations, not analytics.
   *
   * `today` is midnight in the database session's timezone, which on a managed
   * Postgres is UTC. The console labels it as such rather than pretending it is
   * the operator's local day.
   */
  async stats() {
    const { rows } = await query<{
      total: string;
      today: string;
      last_7: string;
      last_30: string;
    }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('day', NOW())) AS today,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last_7,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS last_30
         FROM senior_health_leads`,
    );

    // An aggregate with no GROUP BY always returns exactly one row.
    const row = rows[0]!;
    return {
      total: Number(row.total),
      today: Number(row.today),
      last7Days: Number(row.last_7),
      last30Days: Number(row.last_30),
    };
  },
};
