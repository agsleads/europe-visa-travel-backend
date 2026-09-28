-- Senior Health Benefits Medicare lead intake (seniorhealthbenefits.net).
--
-- Fourth producer, and its own tables for the same reasons 003 gave: a
-- different set of answers, a different credential, and its own retention
-- rules. Widening one shared `leads` table for a third time would leave every
-- row mostly NULL.
--
-- What makes this producer different from Final Expense is what it does NOT
-- ask. Its quote form takes a name, a ZIP, a state and a phone number -- no
-- email address, no date of birth, no coverage amount. That has two
-- consequences the schema has to carry:
--
--   - There is no email column, so "has this person contacted us before?" is
--     answered on the phone number alone. A lead whose phone cannot be
--     normalised to E.164 therefore has no repeat signal at all, which is
--     correct: guessing on a name would merge two different people.
--   - `state` is stored as well as `zip`. The two are redundant in a correct
--     submission and the ZIP is the authoritative one, but the visitor chose
--     the state explicitly and an agent is licensed per state, so the answer
--     they actually gave is what gets recorded.
--
-- Senior Health Benefits is an agency, not an insurer, and is not affiliated
-- with the federal Medicare program. Nothing here is a "policy" or a
-- "customer" -- these are people who asked to be contacted about plan options.

-- ---------------------------------------------------------------------------
-- senior_health_leads -- one row per submission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS senior_health_leads (
    id                BIGSERIAL     PRIMARY KEY,

    -- sha256 of the source and the submission id generated in the visitor's
    -- browser. Re-sent on a retry after a network error that may or may not
    -- have reached us, which is what turns that retry into the original lead
    -- rather than a second one.
    dedupe_key        CHAR(64)      NOT NULL UNIQUE,

    -- The producer's receipt time, not ours. created_at is when this row was
    -- written; the two differ by the network and by any retry.
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- Which site and form sent it. A column rather than an assumption baked
    -- into the table name, so a second Medicare domain needs no migration.
    source            VARCHAR(100)  NOT NULL,

    first_name        VARCHAR(50)   NOT NULL,
    last_name         VARCHAR(50)   NOT NULL,

    -- Stored as received AND normalised. The raw form is what the person typed
    -- and what the consent record refers to; the E.164 form is what a dialler
    -- uses and the only thing repeat detection can match on here. A NULL e164
    -- means the number could not be normalised, not that it is absent.
    phone_raw         VARCHAR(30)   NOT NULL,
    phone_e164        VARCHAR(16),

    zip               VARCHAR(10)   NOT NULL,
    -- The two-letter USPS code the visitor selected. Upper-cased on the way in
    -- so the column has one representation and the CHECK can be exact.
    state             CHAR(2)       NOT NULL,

    -- The complete original body, unmodified. When the site gains an answer
    -- this schema does not model, or someone disputes what was submitted, this
    -- is the answer -- every column above is a projection of it.
    raw_payload       JSONB         NOT NULL,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT senior_health_leads_zip_shape_check CHECK (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
    CONSTRAINT senior_health_leads_state_shape_check CHECK (state ~ '^[A-Z]{2}$')
);

-- The dashboard's default view: newest first.
CREATE INDEX IF NOT EXISTS senior_health_leads_created_at_idx
    ON senior_health_leads (created_at DESC);

-- Repeat-submission detection, looked up per row in the list query. Without it
-- each page would scan the table once per row. Only the phone: see the note at
-- the top of the file.
CREATE INDEX IF NOT EXISTS senior_health_leads_phone_e164_idx
    ON senior_health_leads (phone_e164);

-- ---------------------------------------------------------------------------
-- senior_health_lead_consents -- TCPA evidence. APPEND-ONLY.
-- ---------------------------------------------------------------------------
-- Consent to be contacted, including by autodialler and text, is proven by the
-- exact text the person saw, its version, when they agreed, and the IP and user
-- agent it came from. All of it is stored verbatim on this row.
--
-- consent_text is the full string, NOT a foreign key to a template table. That
-- is the point: when the live wording on the site changes, what this row says
-- the person agreed to must not change with it. It matters more here than on
-- the other producers, because a phone number collected with no email is
-- contacted by call and text and nothing else.
--
-- There is no updated_at, and nothing in this codebase issues an UPDATE or a
-- DELETE against this table. Where the deployment can, revoke both at the
-- database-role level for the application user.
--
-- ON DELETE RESTRICT, not CASCADE: consent evidence must outlive the lead it
-- belongs to. Honouring a deletion request means redacting the personal columns
-- on senior_health_leads in place, not dropping the row.
CREATE TABLE IF NOT EXISTS senior_health_lead_consents (
    id                BIGSERIAL     PRIMARY KEY,
    lead_id           BIGINT        NOT NULL UNIQUE
                                    REFERENCES senior_health_leads(id) ON DELETE RESTRICT,

    consent_text      TEXT          NOT NULL,
    consent_version   VARCHAR(80)   NOT NULL,
    consented_at      TIMESTAMPTZ   NOT NULL,

    -- VARCHAR rather than INET. The value is whatever the site read out of a
    -- proxy header; a malformed one must land in the evidence record as-is, not
    -- fail the insert and lose the lead. 45 characters fits IPv6.
    ip_address        VARCHAR(45),
    user_agent        TEXT,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT senior_health_lead_consents_text_present_check CHECK (char_length(consent_text) > 0)
);

CREATE INDEX IF NOT EXISTS senior_health_lead_consents_version_idx
    ON senior_health_lead_consents (consent_version);
