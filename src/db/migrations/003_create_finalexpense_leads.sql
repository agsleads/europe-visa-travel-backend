-- Final Expense Coverage lead intake (finalexpensecoverage.us).
--
-- Same shape as the Road Cover intake in 002, for the same reasons, and kept in
-- its own tables rather than widening `leads`: the two producers ask different
-- questions (a vehicle year against a date of birth and a coverage amount), are
-- called with different credentials, and will be retained under different
-- rules. One shared table would be a column list that is half NULL for every row.
--
-- Two tables, deliberately not one. A lead is operational data; a consent
-- record is legal evidence that must never change. Folding them together would
-- put the consent text on a row that has an UPDATE path.
--
-- Final Expense Coverage is an agency, not an insurer. Nothing here is a
-- "policy" or a "customer" -- these are requests from people who asked to be
-- contacted about a quote.

-- ---------------------------------------------------------------------------
-- final_expense_leads -- one row per submission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS final_expense_leads (
    id                BIGSERIAL     PRIMARY KEY,

    -- sha256 of the submission id the site generates in the visitor's browser.
    -- The same id is re-sent if the visitor retries after a network error that
    -- may or may not have reached us, and this is what turns that retry into
    -- the original lead instead of a second one.
    dedupe_key        CHAR(64)      NOT NULL UNIQUE,

    -- The producer's own receipt time, not ours. created_at records when the
    -- row was written here; the two differ by the network and by any retry, and
    -- conflating them would misreport how long someone has been waiting.
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- Which site sent it. One column rather than an assumption baked into the
    -- table name, so a second Final Expense domain needs no migration.
    source            VARCHAR(100)  NOT NULL,

    first_name        VARCHAR(50)   NOT NULL,
    last_name         VARCHAR(50)   NOT NULL,

    -- Stored as received AND normalised. The raw form is what the person typed
    -- and what the consent record refers to; the E.164 form is what a dialler
    -- uses and what "has this person submitted before?" matches on. A NULL e164
    -- means the number could not be normalised, not that it is absent.
    phone_raw         VARCHAR(30)   NOT NULL,
    phone_e164        VARCHAR(16),
    email             VARCHAR(254)  NOT NULL,
    email_normalised  VARCHAR(254)  NOT NULL,

    zip               VARCHAR(10)   NOT NULL,

    -- A DATE, not a TIMESTAMPTZ: a birthday has no time and no timezone, and a
    -- timestamp would let it shift by a day when read back in another zone.
    -- Sensitive: with a name and a phone number this is enough to attempt
    -- identity fraud, so the list endpoint never returns it.
    date_of_birth     DATE          NOT NULL,
    -- Derived at submission time from date_of_birth and submitted_at, and stored
    -- because "how old were they when they asked" must not change as the row
    -- ages, and because the dashboard filters and sorts on it.
    age               SMALLINT      NOT NULL,
    -- Whole US dollars the person asked to be quoted for.
    coverage_amount   INTEGER       NOT NULL,

    -- The complete original body, unmodified. Kept for as long as the row is.
    -- When a producer field appears that this schema does not model, or someone
    -- disputes what was submitted, this is the answer -- every column above is a
    -- projection of it and can be rebuilt from it.
    raw_payload       JSONB         NOT NULL,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Deliberately wider than the site's own 50-85 rule. The API rejects an
    -- implausible age with a 422; these constraints exist to catch a coding
    -- error, and pinning them to the site's current bounds would turn a future
    -- marketing decision (a 45+ product) into a 500 on a real lead.
    CONSTRAINT final_expense_leads_age_check CHECK (age BETWEEN 0 AND 130),
    CONSTRAINT final_expense_leads_coverage_check CHECK (coverage_amount BETWEEN 1 AND 10000000),
    CONSTRAINT final_expense_leads_zip_shape_check CHECK (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
    CONSTRAINT final_expense_leads_email_shape_check CHECK (POSITION('@' IN email) > 1)
);

-- The dashboard's default view: newest first.
CREATE INDEX IF NOT EXISTS final_expense_leads_created_at_idx
    ON final_expense_leads (created_at DESC);

-- Repeat-submission detection. Both are looked up per row in the list query,
-- so without these each page would scan the table once per row.
CREATE INDEX IF NOT EXISTS final_expense_leads_email_normalised_idx
    ON final_expense_leads (email_normalised);
CREATE INDEX IF NOT EXISTS final_expense_leads_phone_e164_idx
    ON final_expense_leads (phone_e164);

-- ---------------------------------------------------------------------------
-- final_expense_lead_consents -- TCPA evidence. APPEND-ONLY.
-- ---------------------------------------------------------------------------
-- Consent to be contacted, including by autodialler and text, is proven by the
-- exact text the person saw, its version, when they agreed, and the IP and user
-- agent it came from. All of it is stored verbatim on this row.
--
-- consent_text is the full string, NOT a foreign key to a template table. That
-- is the entire point: when the live wording on the site changes, what this row
-- says the person agreed to must not change with it.
--
-- There is no updated_at, and nothing in this codebase issues an UPDATE or a
-- DELETE against this table. Where the deployment can, revoke both at the
-- database-role level for the application user.
--
-- ON DELETE RESTRICT, not CASCADE: consent evidence is required to outlive the
-- lead it belongs to. Honouring a deletion request means redacting the personal
-- columns on final_expense_leads in place, not dropping the row.
CREATE TABLE IF NOT EXISTS final_expense_lead_consents (
    id                BIGSERIAL     PRIMARY KEY,
    lead_id           BIGINT        NOT NULL UNIQUE
                                    REFERENCES final_expense_leads(id) ON DELETE RESTRICT,

    consent_text      TEXT          NOT NULL,
    consent_version   VARCHAR(80)   NOT NULL,
    consented_at      TIMESTAMPTZ   NOT NULL,

    -- VARCHAR rather than INET. The value is whatever the site read out of a
    -- proxy header; a malformed one must land in the evidence record as-is, not
    -- fail the insert and lose the lead. 45 characters fits IPv6.
    ip_address        VARCHAR(45),
    user_agent        TEXT,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT final_expense_lead_consents_text_present_check CHECK (char_length(consent_text) > 0)
);

CREATE INDEX IF NOT EXISTS final_expense_lead_consents_version_idx
    ON final_expense_lead_consents (consent_version);
