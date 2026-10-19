-- The CRM's user directory: the admins and consultants who work enquiries.
--
-- The id is text rather than a serial because enquiries already store their
-- assignee as an opaque string (enquiries.assigned_to_id). Ids are generated
-- by the service as `usr_` plus random characters.
--
-- No foreign key from enquiries.assigned_to_id: an enquiry keeps its stored
-- assignee name even after that user is deleted, so its history stays legible.

CREATE TABLE IF NOT EXISTS crm_users (
    id              VARCHAR(64)   PRIMARY KEY,
    -- Signs in with this or the email. Lower-case letters, digits, dots,
    -- underscores and hyphens; stored lower-case.
    username        VARCHAR(50)   NOT NULL,
    name            VARCHAR(100)  NOT NULL,
    email           VARCHAR(254)  NOT NULL,
    phone           VARCHAR(30),
    role            VARCHAR(10)   NOT NULL DEFAULT 'user',
    status          VARCHAR(10)   NOT NULL DEFAULT 'active',
    job_title       VARCHAR(100),
    -- A small square image as a data URL, or an https URL. Bounded so a row
    -- cannot carry an arbitrarily large blob.
    avatar_url      TEXT,
    -- scrypt, self-describing: `scrypt$N$r$p$salt$hash`. Never selected into
    -- anything that is returned to a caller.
    password_hash   VARCHAR(255)  NOT NULL,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT crm_users_role_check   CHECK (role IN ('admin', 'user')),
    CONSTRAINT crm_users_status_check CHECK (status IN ('active', 'inactive')),
    CONSTRAINT crm_users_username_shape_check CHECK (username ~ '^[a-z0-9._-]{3,50}$'),
    CONSTRAINT crm_users_email_shape_check CHECK (POSITION('@' IN email) > 1),
    CONSTRAINT crm_users_avatar_length_check CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 60000)
);

-- One account per username and per address, regardless of case.
CREATE UNIQUE INDEX IF NOT EXISTS crm_users_username_unique_idx ON crm_users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS crm_users_email_unique_idx ON crm_users (LOWER(email));

DROP TRIGGER IF EXISTS crm_users_set_updated_at ON crm_users;
CREATE TRIGGER crm_users_set_updated_at
    BEFORE UPDATE ON crm_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
