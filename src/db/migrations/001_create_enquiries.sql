-- Enquiries submitted through the public /contact form.
--
-- Column widths mirror the caps in the shared zod schema. Enforcing them here
-- too means a bug or a future second writer cannot store a 10 MB "message" —
-- the database is the last line, not a dumb store.

CREATE TABLE IF NOT EXISTS enquiries (
    id              BIGSERIAL     PRIMARY KEY,
    -- Human-quotable, shown to the enquirer and used in reply threads.
    reference       VARCHAR(20)   NOT NULL UNIQUE,

    name            VARCHAR(100)  NOT NULL,
    email           VARCHAR(254)  NOT NULL,
    phone           VARCHAR(30),
    destination     VARCHAR(100)  NOT NULL,
    visa_type       VARCHAR(100)  NOT NULL,
    travel_month    VARCHAR(40)   NOT NULL,
    message         TEXT          NOT NULL,

    -- UK GDPR Art. 7(1): consent must be demonstrable after the fact, which
    -- means recording that it was given and when — not just that a box existed.
    consent         BOOLEAN       NOT NULL DEFAULT FALSE,
    consented_at    TIMESTAMPTZ,

    status          VARCHAR(20)   NOT NULL DEFAULT 'new',

    -- Operational context. Deliberately NOT the raw IP: the client address is
    -- only ever stored as a salted hash, used for abuse correlation and
    -- nothing else, so a database dump cannot be reversed into a location.
    client_hash     VARCHAR(64),
    user_agent      VARCHAR(400),
    source          VARCHAR(50)   NOT NULL DEFAULT 'website',

    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT enquiries_status_check
        CHECK (status IN ('new', 'in_progress', 'responded', 'closed', 'spam')),
    CONSTRAINT enquiries_message_length_check
        CHECK (char_length(message) BETWEEN 10 AND 2000),
    -- Cheap structural sanity check. Real address validity is a delivery
    -- question, not a regex question; this only rejects the obviously broken.
    CONSTRAINT enquiries_email_shape_check
        CHECK (POSITION('@' IN email) > 1)
);

-- The operator's default view: newest first, filtered by status.
CREATE INDEX IF NOT EXISTS enquiries_status_created_at_idx
    ON enquiries (status, created_at DESC);

-- Supports "has this person written before?" and the retention purge.
CREATE INDEX IF NOT EXISTS enquiries_email_idx ON enquiries (LOWER(email));
CREATE INDEX IF NOT EXISTS enquiries_created_at_idx ON enquiries (created_at);

-- updated_at maintained in the database, so it stays correct no matter which
-- client writes the row.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enquiries_set_updated_at ON enquiries;
CREATE TRIGGER enquiries_set_updated_at
    BEFORE UPDATE ON enquiries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
