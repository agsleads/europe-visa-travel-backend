-- In-app notifications for CRM users: "a lead was assigned to you", "a lead
-- converted", "a new user joined".
--
-- One row per recipient. ON DELETE CASCADE from crm_users, so deleting a user
-- removes their inbox with them.

CREATE TABLE IF NOT EXISTS crm_notifications (
    id          BIGSERIAL     PRIMARY KEY,
    user_id     VARCHAR(64)   NOT NULL REFERENCES crm_users (id) ON DELETE CASCADE,
    type        VARCHAR(30)   NOT NULL,
    title       VARCHAR(150)  NOT NULL,
    message     VARCHAR(500)  NOT NULL,
    -- An in-app path such as /leads/42. Relative only, so a notification can
    -- never send someone to another site.
    link        VARCHAR(300),
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT crm_notifications_type_check CHECK (type IN (
        'lead_assigned', 'status_changed', 'follow_up_due', 'user_added', 'lead_converted'
    )),
    CONSTRAINT crm_notifications_link_check CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%'))
);

-- A user's inbox, newest first, and the unread badge count.
CREATE INDEX IF NOT EXISTS crm_notifications_user_created_at_idx
    ON crm_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_notifications_user_unread_idx
    ON crm_notifications (user_id) WHERE read_at IS NULL;
