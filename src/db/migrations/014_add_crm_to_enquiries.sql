-- Enquiries become CRM leads.
--
-- Every enquiry is now worked as a sales lead: it moves through a pipeline,
-- carries a priority, is owned by a named rep, and accumulates activity, notes
-- and follow-ups.

-- 1. Status becomes the CRM pipeline.
--
-- Existing rows are mapped onto the nearest pipeline stage: anything already
-- being worked or answered has been contacted, and anything closed or spam is
-- no longer a live opportunity. `converted` has no old equivalent — whether a
-- closed enquiry became a customer was never recorded — so nothing maps to it.
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_status_check;

UPDATE enquiries SET status = 'contacted' WHERE status IN ('in_progress', 'responded');
UPDATE enquiries SET status = 'lost'      WHERE status IN ('closed', 'spam');

ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'proposal', 'converted', 'lost'));

-- 2. Lead fields.
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS priority         VARCHAR(10)  NOT NULL DEFAULT 'medium',
    -- The owning rep. The CRM's user directory lives outside this service, so
    -- the id is opaque here and the name is stored alongside it: any client can
    -- render "Assigned to Sarah Chen" without a second lookup, and the row stays
    -- legible if that user is later removed from the CRM.
    ADD COLUMN IF NOT EXISTS assigned_to_id   VARCHAR(64),
    ADD COLUMN IF NOT EXISTS assigned_to_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS assigned_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_contact_at  TIMESTAMPTZ;

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_priority_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_priority_check
    CHECK (priority IN ('low', 'medium', 'high', 'urgent'));

-- An id without a name (or the reverse) is a half-written assignment.
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_assignee_pair_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_assignee_pair_check
    CHECK ((assigned_to_id IS NULL) = (assigned_to_name IS NULL));

-- "My leads" and the unassigned queue, newest first.
CREATE INDEX IF NOT EXISTS enquiries_assigned_to_created_at_idx
    ON enquiries (assigned_to_id, created_at DESC);

-- 3. Activity: an append-only history of everything done to an enquiry.
--
-- Actor columns follow the same id-plus-name rule as the assignee. ON DELETE
-- CASCADE on every child table so the retention purge removes the history,
-- notes and follow-ups along with the personal data they describe.
CREATE TABLE IF NOT EXISTS enquiry_activities (
    id           BIGSERIAL     PRIMARY KEY,
    enquiry_id   BIGINT        NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
    type         VARCHAR(30)   NOT NULL,
    description  VARCHAR(500)  NOT NULL,
    actor_id     VARCHAR(64),
    actor_name   VARCHAR(100),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT enquiry_activities_type_check CHECK (type IN (
        'created', 'assigned', 'unassigned', 'status_changed', 'priority_changed',
        'call', 'email', 'whatsapp', 'note_added', 'follow_up_added', 'follow_up_completed'
    ))
);

CREATE INDEX IF NOT EXISTS enquiry_activities_enquiry_created_at_idx
    ON enquiry_activities (enquiry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS enquiry_activities_created_at_idx
    ON enquiry_activities (created_at DESC);

-- Existing enquiries get the "created" entry new ones receive on insert, so
-- every timeline starts at the beginning.
INSERT INTO enquiry_activities (enquiry_id, type, description, created_at)
SELECT e.id, 'created', 'Enquiry received from ' || e.source, e.created_at
  FROM enquiries e
 WHERE NOT EXISTS (SELECT 1 FROM enquiry_activities a WHERE a.enquiry_id = e.id);

-- 4. Notes.
CREATE TABLE IF NOT EXISTS enquiry_notes (
    id           BIGSERIAL     PRIMARY KEY,
    enquiry_id   BIGINT        NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
    content      TEXT          NOT NULL,
    author_id    VARCHAR(64),
    author_name  VARCHAR(100),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT enquiry_notes_content_length_check CHECK (char_length(content) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS enquiry_notes_enquiry_created_at_idx
    ON enquiry_notes (enquiry_id, created_at DESC);

DROP TRIGGER IF EXISTS enquiry_notes_set_updated_at ON enquiry_notes;
CREATE TRIGGER enquiry_notes_set_updated_at
    BEFORE UPDATE ON enquiry_notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Follow-ups.
CREATE TABLE IF NOT EXISTS enquiry_follow_ups (
    id               BIGSERIAL     PRIMARY KEY,
    enquiry_id       BIGINT        NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
    title            VARCHAR(120)  NOT NULL,
    due_at           TIMESTAMPTZ   NOT NULL,
    completed        BOOLEAN       NOT NULL DEFAULT FALSE,
    completed_at     TIMESTAMPTZ,
    created_by_id    VARCHAR(64),
    created_by_name  VARCHAR(100),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT enquiry_follow_ups_title_length_check CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT enquiry_follow_ups_completed_pair_check CHECK (completed = (completed_at IS NOT NULL))
);

-- Serves both "next follow-up per enquiry" and "upcoming follow-ups".
CREATE INDEX IF NOT EXISTS enquiry_follow_ups_open_due_idx
    ON enquiry_follow_ups (enquiry_id, due_at) WHERE NOT completed;
CREATE INDEX IF NOT EXISTS enquiry_follow_ups_due_idx
    ON enquiry_follow_ups (due_at) WHERE NOT completed;

DROP TRIGGER IF EXISTS enquiry_follow_ups_set_updated_at ON enquiry_follow_ups;
CREATE TRIGGER enquiry_follow_ups_set_updated_at
    BEFORE UPDATE ON enquiry_follow_ups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
