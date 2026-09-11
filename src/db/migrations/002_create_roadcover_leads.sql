-- Road Cover lead intake (roadcover.us).
--
-- Three tables, deliberately not one. A lead is operational data an operator
-- edits; a consent record is legal evidence that must never change; attribution
-- is marketing data with a different lifetime from both. Folding them into one
-- row would put the consent text on a row that has an UPDATE path.
--
-- Road Cover is not an insurer. Nothing here is a "quote", a "policy" or a
-- "customer" -- these are requests from consumers who asked to be contacted.

-- ---------------------------------------------------------------------------
-- leads -- one row per submission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id                BIGSERIAL     PRIMARY KEY,

    -- sha256 of sessionId + formCompletedAt. The producer does not retry, but
    -- proxies and operators replaying a webhook do. This is what makes a replay
    -- return the original lead instead of creating a second one.
    dedupe_key        CHAR(64)      NOT NULL UNIQUE,

    -- The producer's own receipt time, not ours. created_at records when the
    -- row was written here; the two differ by the network and by any replay,
    -- and conflating them would misreport how long a consumer has been waiting.
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- The nine answers. Typed columns because the dashboard filters and sorts
    -- on them; the verbatim strings survive in raw_payload.
    zip               VARCHAR(10)   NOT NULL,
    -- What the consumer selected. The select is pre-filled from the ZIP but is
    -- editable, so this is their claim about where they live.
    state_selected    CHAR(2)       NOT NULL,
    -- Re-derived from the ZIP by the producer. NULL means an unrecognised ZIP
    -- prefix. A disagreement between the two is a data-quality signal, not an
    -- error -- both are kept and the dashboard flags the mismatch.
    state_from_zip    CHAR(2),
    vehicle_year      SMALLINT      NOT NULL,
    currently_insured BOOLEAN       NOT NULL,
    first_name        VARCHAR(50)   NOT NULL,
    last_name         VARCHAR(50)   NOT NULL,
    age               SMALLINT      NOT NULL,

    -- Stored as received AND normalised. The raw form is what the consumer
    -- typed and what the consent record refers to; the E.164 form is what a
    -- dialler uses and what "has this person submitted before?" matches on.
    -- A NULL e164 means the number could not be normalised, not that it is absent.
    phone_raw         VARCHAR(30)   NOT NULL,
    phone_e164        VARCHAR(16),
    email             VARCHAR(254)  NOT NULL,
    email_normalised  VARCHAR(254)  NOT NULL,

    status            VARCHAR(20)   NOT NULL DEFAULT 'new',

    -- The complete original body, unmodified. Kept forever. When a producer
    -- field appears that this schema does not model, or someone disputes what
    -- was submitted, this is the answer -- every column above is a projection
    -- of it and can be rebuilt from it.
    raw_payload       JSONB         NOT NULL,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT leads_status_check
        CHECK (status IN ('new', 'contacted', 'sold', 'rejected', 'duplicate')),

    -- Deliberately wider than the producer's own 16-100 rule. The API returns
    -- 422 for an out-of-range age; this constraint exists to catch a coding
    -- error, and pinning it to the producer's current bounds would turn a
    -- future rule change into a 500 on a real lead.
    CONSTRAINT leads_age_check CHECK (age > 0 AND age < 200),
    CONSTRAINT leads_vehicle_year_check CHECK (vehicle_year BETWEEN 1900 AND 2100),
    CONSTRAINT leads_zip_shape_check CHECK (zip ~ '^[0-9]{5}$'),
    CONSTRAINT leads_email_shape_check CHECK (POSITION('@' IN email) > 1)
);

-- The dashboard's default view, and its status filter.
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_created_at_idx ON leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_state_from_zip_idx ON leads (state_from_zip);

-- Repeat-submission detection. Both are looked up per row in the list query,
-- so without these each page would scan the table once per row.
CREATE INDEX IF NOT EXISTS leads_email_normalised_idx ON leads (email_normalised);
CREATE INDEX IF NOT EXISTS leads_phone_e164_idx ON leads (phone_e164);

-- ---------------------------------------------------------------------------
-- lead_consents -- TCPA evidence. APPEND-ONLY.
-- ---------------------------------------------------------------------------
-- The consumer's consent to be contacted is proven by the exact text they saw,
-- its version, when they agreed, and the IP and user agent it came from. All of
-- it is stored verbatim on this row.
--
-- consent_text is the full ~700-character string, NOT a foreign key to a
-- template table. That is the entire point: when the live wording in the
-- producer's lib/consent.ts changes, what this row says the consumer agreed to
-- must not change with it.
--
-- There is no updated_at, and nothing in this codebase issues an UPDATE or a
-- DELETE against this table. Where the deployment can, revoke both at the
-- database-role level for the application user.
--
-- ON DELETE RESTRICT, not CASCADE: consent evidence is required to outlive the
-- lead it belongs to. Honouring a CCPA/CPRA deletion request means redacting
-- the personal columns on leads in place, not dropping the row.
CREATE TABLE IF NOT EXISTS lead_consents (
    id                    BIGSERIAL     PRIMARY KEY,
    lead_id               BIGINT        NOT NULL UNIQUE
                                        REFERENCES leads(id) ON DELETE RESTRICT,

    consent_text          TEXT          NOT NULL,
    consent_version       VARCHAR(40)   NOT NULL,
    consented_at          TIMESTAMPTZ   NOT NULL,

    -- VARCHAR rather than INET. The value is whatever the producer read out of
    -- a proxy header; a malformed one must land in the evidence record as-is,
    -- not fail the insert and lose the lead. 45 characters fits IPv6.
    ip_address            VARCHAR(45),
    user_agent            TEXT,
    -- The first page of the session, which is where the consumer saw the
    -- consent language. Not capped at 255 -- campaign URLs run long.
    landing_page_url      TEXT,
    -- Always NULL today. The column exists so TrustedForm can be switched on
    -- at the producer without a migration here.
    trusted_form_cert_url TEXT,

    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT lead_consents_text_present_check CHECK (char_length(consent_text) > 0)
);

CREATE INDEX IF NOT EXISTS lead_consents_version_idx ON lead_consents (consent_version);

-- ---------------------------------------------------------------------------
-- lead_attribution -- where the lead came from
-- ---------------------------------------------------------------------------
-- CASCADE here, unlike consents: attribution is marketing data, not evidence,
-- and it has no meaning once the lead is gone.
CREATE TABLE IF NOT EXISTS lead_attribution (
    lead_id           BIGINT        PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,

    utm_source        VARCHAR(200),
    utm_medium        VARCHAR(200),
    utm_campaign      VARCHAR(200),
    utm_term          VARCHAR(200),
    utm_content       VARCHAR(200),
    gclid             TEXT,
    fbclid            TEXT,
    referrer          TEXT,

    -- NOT unique: one browser session can legitimately submit more than once.
    session_id        VARCHAR(100)  NOT NULL,
    -- NULL when storage was blocked in the consumer's browser. The gap between
    -- the two is a fraud signal -- an implausibly fast completion -- so it is
    -- surfaced in the dashboard rather than hidden.
    form_started_at   TIMESTAMPTZ,
    form_completed_at TIMESTAMPTZ   NOT NULL
);

CREATE INDEX IF NOT EXISTS lead_attribution_campaign_idx ON lead_attribution (utm_campaign);
CREATE INDEX IF NOT EXISTS lead_attribution_source_idx ON lead_attribution (utm_source);
CREATE INDEX IF NOT EXISTS lead_attribution_session_idx ON lead_attribution (session_id);

-- leads.updated_at is maintained by the database, reusing the trigger function
-- created in 001. lead_consents and lead_attribution deliberately get no such
-- trigger -- neither is ever updated.
DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
