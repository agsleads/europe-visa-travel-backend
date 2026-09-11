import { query, withTransaction } from "@/db/pool";
import {
  LEAD_STATUSES,
  type CreateLead,
  type Lead,
  type LeadDetail,
  type LeadListItem,
  type LeadStats,
  type LeadStatus,
  type ListLeadsQuery,
} from "@/domain/lead.schema";

/**
 * Data access for Road Cover leads. SQL lives here and nowhere else.
 *
 * Every write goes through one transaction covering all three tables: a lead
 * without its consent record is not a partially-saved lead, it is a lead that
 * cannot lawfully be contacted. Saving one without the other is worse than
 * saving neither.
 */

/* -------------------------------------------------------------------- rows */

interface LeadRow {
  id: string; // BIGSERIAL arrives as a string; pg will not silently lose precision.
  submitted_at: Date;
  zip: string;
  state_selected: string;
  state_from_zip: string | null;
  vehicle_year: number;
  currently_insured: boolean;
  first_name: string;
  last_name: string;
  age: number;
  phone_raw: string;
  phone_e164: string | null;
  email: string;
  status: LeadStatus;
  created_at: Date;
  updated_at: Date;
  is_repeat: boolean;
}

interface LeadListRow extends LeadRow {
  utm_source: string | null;
  utm_campaign: string | null;
}

interface LeadDetailRow extends LeadRow {
  raw_payload: unknown;
  consent_text: string;
  consent_version: string;
  consented_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  landing_page_url: string | null;
  trusted_form_cert_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  gclid: string | null;
  fbclid: string | null;
  referrer: string | null;
  session_id: string;
  form_started_at: Date | null;
  form_completed_at: Date;
}

/**
 * The lead columns, plus the repeat-submission flag.
 *
 * `state_selected` and `state_from_zip` are CHAR(2), which Postgres pads; the
 * padding would show up in the dashboard as "FL " and break an equality test in
 * JavaScript, so both are trimmed on the way out.
 */
const LEAD_COLUMNS = `
  l.id, l.submitted_at, l.zip,
  TRIM(l.state_selected) AS state_selected,
  TRIM(l.state_from_zip) AS state_from_zip,
  l.vehicle_year, l.currently_insured, l.first_name, l.last_name, l.age,
  l.phone_raw, l.phone_e164, l.email, l.status, l.created_at, l.updated_at,
  EXISTS (
    SELECT 1 FROM leads earlier
     WHERE earlier.id < l.id
       AND (earlier.email_normalised = l.email_normalised
            OR (earlier.phone_e164 IS NOT NULL AND earlier.phone_e164 = l.phone_e164))
  ) AS is_repeat
`;

function toLead(row: LeadRow): Lead {
  return {
    id: Number(row.id),
    submittedAt: row.submitted_at,
    zip: row.zip,
    stateSelected: row.state_selected,
    stateFromZip: row.state_from_zip,
    vehicleYear: row.vehicle_year,
    currentlyInsured: row.currently_insured,
    firstName: row.first_name,
    lastName: row.last_name,
    age: row.age,
    phoneRaw: row.phone_raw,
    phoneE164: row.phone_e164,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isRepeat: row.is_repeat,
  };
}

function toLeadDetail(row: LeadDetailRow, relatedLeadIds: number[]): LeadDetail {
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
      landingPageUrl: row.landing_page_url,
      trustedFormCertUrl: row.trusted_form_cert_url,
    },
    attribution: {
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmTerm: row.utm_term,
      utmContent: row.utm_content,
      gclid: row.gclid,
      fbclid: row.fbclid,
      referrer: row.referrer,
      sessionId: row.session_id,
      formStartedAt: row.form_started_at,
      formCompletedAt: row.form_completed_at,
    },
  };
}

/** What a create attempt did, so the service can answer 201 or 200. */
export interface CreateLeadResult {
  lead: Lead;
  /** True when the dedupe key already existed and nothing was written. */
  duplicate: boolean;
}

export interface LeadRepository {
  create(input: CreateLead): Promise<CreateLeadResult>;
  findById(id: number): Promise<LeadDetail | null>;
  list(params: ListLeadsQuery): Promise<{ items: LeadListItem[]; total: number }>;
  stats(): Promise<LeadStats>;
  updateStatus(id: number, status: LeadStatus): Promise<Lead | null>;
}

export const leadRepository: LeadRepository = {
  /**
   * Writes the lead, its consent record and its attribution in one transaction.
   *
   * Idempotent on `dedupe_key`. `ON CONFLICT DO NOTHING` rather than a
   * SELECT-then-INSERT: two concurrent replays of the same webhook would both
   * pass a prior existence check and one would then fail on the unique index,
   * returning a 500 for what is a successful, already-recorded submission.
   */
  async create(input) {
    return withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO leads
           (dedupe_key, submitted_at, zip, state_selected, state_from_zip,
            vehicle_year, currently_insured, first_name, last_name, age,
            phone_raw, phone_e164, email, email_normalised, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [
          input.dedupeKey,
          input.submittedAt,
          input.zip,
          input.stateSelected,
          input.stateFromZip,
          input.vehicleYear,
          input.currentlyInsured,
          input.firstName,
          input.lastName,
          input.age,
          input.phoneRaw,
          input.phoneE164,
          input.email,
          input.emailNormalised,
          JSON.stringify(input.rawPayload),
        ],
      );

      const row = inserted.rows[0];

      /* Conflict: this submission is already recorded. Return the original
         rather than writing a second consent row against it -- the consent
         table is append-only and one submission has exactly one consent. */
      if (!row) {
        const existing = await client.query<LeadRow>(
          `SELECT ${LEAD_COLUMNS} FROM leads l WHERE l.dedupe_key = $1`,
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
        `INSERT INTO lead_consents
           (lead_id, consent_text, consent_version, consented_at,
            ip_address, user_agent, landing_page_url, trusted_form_cert_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          leadId,
          input.consent.text,
          input.consent.version,
          input.consent.consentedAt,
          input.consent.ipAddress,
          input.consent.userAgent,
          input.consent.landingPageUrl,
          input.consent.trustedFormCertUrl,
        ],
      );

      await client.query(
        `INSERT INTO lead_attribution
           (lead_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            gclid, fbclid, referrer, session_id, form_started_at, form_completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          leadId,
          input.attribution.utmSource,
          input.attribution.utmMedium,
          input.attribution.utmCampaign,
          input.attribution.utmTerm,
          input.attribution.utmContent,
          input.attribution.gclid,
          input.attribution.fbclid,
          input.attribution.referrer,
          input.attribution.sessionId,
          input.attribution.formStartedAt,
          input.attribution.formCompletedAt,
        ],
      );

      const saved = await client.query<LeadRow>(
        `SELECT ${LEAD_COLUMNS} FROM leads l WHERE l.id = $1`,
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
              c.ip_address, c.user_agent, c.landing_page_url, c.trusted_form_cert_url,
              a.utm_source, a.utm_medium, a.utm_campaign, a.utm_term, a.utm_content,
              a.gclid, a.fbclid, a.referrer, a.session_id,
              a.form_started_at, a.form_completed_at
         FROM leads l
         /* Consent and attribution are written in the same transaction as the
            lead, so an INNER JOIN would also match today. LEFT keeps a lead
            that somehow lost a child row readable in the dashboard rather than
            invisible -- an operator who cannot see it cannot fix it. */
         LEFT JOIN lead_consents c ON c.lead_id = l.id
         LEFT JOIN lead_attribution a ON a.lead_id = l.id
        WHERE l.id = $1`,
      [id],
    );

    const row = rows[0];
    if (!row) return null;

    /* Earlier submissions from the same person, for the "seen before" link.
       Bounded: a scraped address could otherwise return thousands of ids into
       a page that renders every one of them. */
    const related = await query<{ id: string }>(
      `SELECT id FROM leads
        WHERE id <> $1
          AND (email_normalised = (SELECT email_normalised FROM leads WHERE id = $1)
               OR (phone_e164 IS NOT NULL
                   AND phone_e164 = (SELECT phone_e164 FROM leads WHERE id = $1)))
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
   * Every filter is expressed as `$n IS NULL OR ...` so one prepared statement
   * serves every combination. Count and page come back together via a window
   * function, for the reason the enquiry repository does the same: two separate
   * queries can disagree if a row lands between them, and a paginator that
   * reports 26 results while returning 25 is a support ticket.
   */
  async list({ status, state, currentlyInsured, utmSource, utmCampaign, q, from, to, limit, offset }) {
    const { rows } = await query<LeadListRow & { total_count: string }>(
      `SELECT ${LEAD_COLUMNS}, a.utm_source, a.utm_campaign, COUNT(*) OVER () AS total_count
         FROM leads l
         LEFT JOIN lead_attribution a ON a.lead_id = l.id
        WHERE ($1::text IS NULL OR l.status = $1)
          AND ($2::text IS NULL OR TRIM(l.state_from_zip) = $2)
          AND ($3::boolean IS NULL OR l.currently_insured = $3)
          AND ($4::text IS NULL OR a.utm_source = $4)
          AND ($5::text IS NULL OR a.utm_campaign = $5)
          AND ($6::timestamptz IS NULL OR l.created_at >= $6)
          AND ($7::timestamptz IS NULL OR l.created_at <= $7)
          /* POSITION, not ILIKE: a LIKE pattern would need the operator's term
             escaped first, or a search for "50%" matches every row. Phone
             search strips punctuation on both sides so "3055550147" finds a
             number stored as "(305) 555-0147". */
          AND ($8::text IS NULL OR (
                POSITION($8 IN LOWER(l.first_name)) > 0
             OR POSITION($8 IN LOWER(l.last_name)) > 0
             OR POSITION($8 IN LOWER(l.first_name || ' ' || l.last_name)) > 0
             OR POSITION($8 IN LOWER(l.email)) > 0
             OR POSITION($8 IN l.zip) > 0
             OR ($9::text <> '' AND POSITION($9 IN REGEXP_REPLACE(l.phone_raw, '\\D', '', 'g')) > 0)))
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $10 OFFSET $11`,
      [
        status ?? null,
        state ?? null,
        currentlyInsured ?? null,
        utmSource ?? null,
        utmCampaign ?? null,
        from ?? null,
        to ?? null,
        q ? q.toLowerCase() : null,
        q ? q.replace(/\D/g, "") : "",
        limit,
        offset,
      ],
    );

    return {
      items: rows.map((row) => ({
        ...toLead(row),
        utmSource: row.utm_source,
        utmCampaign: row.utm_campaign,
      })),
      total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    };
  },

  /**
   * Overview counters, in two round trips rather than one per tile.
   *
   * The status/recency counts are one grouped scan; the state and source
   * breakdowns are a second. Splitting them this way keeps each result set flat
   * -- one query returning all three groupings would need a UNION with a
   * discriminator column and a decode step on the way out.
   */
  async stats() {
    const totals = await query<{
      status: LeadStatus;
      count: string;
      today: string;
      last_7: string;
      last_30: string;
    }>(
      `SELECT status,
              COUNT(*) AS count,
              COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('day', NOW())) AS today,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last_7,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS last_30
         FROM leads
        GROUP BY status`,
    );

    /* Seeded with every status at zero: GROUP BY only returns statuses that
       have rows, so a quiet week would otherwise render as missing tiles
       rather than as tiles reading "0". */
    const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<
      LeadStatus,
      number
    >;

    let total = 0;
    let today = 0;
    let last7Days = 0;
    let last30Days = 0;

    for (const row of totals.rows) {
      const count = Number(row.count);
      byStatus[row.status] = count;
      total += count;
      today += Number(row.today);
      last7Days += Number(row.last_7);
      last30Days += Number(row.last_30);
    }

    /* Both breakdowns in one round trip, told apart by an explicit `kind`
       discriminator rather than by which column came back null. Null is a
       legitimate value in both halves -- an unrecognised ZIP and an untagged
       visit -- so inferring the half from it would file every untagged visit
       under the wrong heading. Each is COALESCEd to a label in SQL, so the
       grouping and the display name are the same value. */
    const breakdown = await query<{ kind: "state" | "source"; label: string; count: string }>(
      `SELECT 'state' AS kind, COALESCE(TRIM(l.state_from_zip), '??') AS label, COUNT(*) AS count
         FROM leads l
        GROUP BY COALESCE(TRIM(l.state_from_zip), '??')
        UNION ALL
       SELECT 'source' AS kind, COALESCE(a.utm_source, 'direct') AS label, COUNT(*) AS count
         FROM leads l
         LEFT JOIN lead_attribution a ON a.lead_id = l.id
        GROUP BY COALESCE(a.utm_source, 'direct')`,
    );

    const byState: { state: string; count: number }[] = [];
    const bySource: { source: string; count: number }[] = [];

    for (const row of breakdown.rows) {
      const count = Number(row.count);
      if (row.kind === "state") byState.push({ state: row.label, count });
      else bySource.push({ source: row.label, count });
    }

    // Postgres does not order grouped output; the dashboard wants busiest first.
    byState.sort((a, b) => b.count - a.count);
    bySource.sort((a, b) => b.count - a.count);

    return { total, today, last7Days, last30Days, byStatus, byState, bySource };
  },

  async updateStatus(id, status) {
    /* UPDATE then re-SELECT, because `is_repeat` is a correlated subquery that
       RETURNING cannot express against the row being written. */
    const updated = await query<{ id: string }>(
      `UPDATE leads SET status = $2 WHERE id = $1 RETURNING id`,
      [id, status],
    );
    if (!updated.rows[0]) return null;

    const { rows } = await query<LeadRow>(
      `SELECT ${LEAD_COLUMNS} FROM leads l WHERE l.id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toLead(row) : null;
  },
};
