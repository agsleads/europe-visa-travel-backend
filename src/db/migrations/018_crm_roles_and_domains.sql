-- Super admins and domains for CRM users.
--
-- A domain is one lead business this service handles (Europe Visa Centre,
-- Road Cover, ...). Admins and users belong to exactly one domain and manage
-- only that domain's people; super admins sit above every domain and have none.

CREATE TABLE IF NOT EXISTS crm_domains (
    key          VARCHAR(30)   PRIMARY KEY,
    name         VARCHAR(100)  NOT NULL,
    description  VARCHAR(200),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT crm_domains_key_shape_check CHECK (key ~ '^[a-z0-9_]{2,30}$')
);

-- The lead producers this service already serves. Onyx is not one: it is a
-- utilisation lookup, not a source of leads anyone works.
INSERT INTO crm_domains (key, name, description) VALUES
    ('evc',            'Europe Visa Centre',      'Visa enquiries from the Europe Visa Centre website'),
    ('roadcover',      'Road Cover',              'Road Cover leads'),
    ('finalexpense',   'Final Expense Coverage',  'Final Expense Coverage leads'),
    ('seniorhealth',   'Senior Health Benefits',  'Senior Health Benefits Medicare leads'),
    ('affordableplan', 'AffordablePlan',          'AffordablePlan leads'),
    ('autoinsurance',  'Explore Auto Insurance',  'Explore Auto Insurance leads'),
    ('socialsecurity', 'Disability Benefit Helps', 'Social security free case review requests')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE crm_users
    ADD COLUMN IF NOT EXISTS domain VARCHAR(30) REFERENCES crm_domains (key) ON UPDATE CASCADE;

ALTER TABLE crm_users DROP CONSTRAINT IF EXISTS crm_users_role_check;
ALTER TABLE crm_users ALTER COLUMN role TYPE VARCHAR(20);
ALTER TABLE crm_users ADD CONSTRAINT crm_users_role_check
    CHECK (role IN ('super_admin', 'admin', 'user'));

-- Everyone so far worked Europe Visa Centre leads, the only domain the CRM
-- served. Existing admins stay admins (of that domain) rather than being
-- promoted: a super admin is created deliberately, not by migration.
UPDATE crm_users SET domain = 'evc' WHERE domain IS NULL AND role IN ('admin', 'user');

-- Super admins span every domain; everyone else belongs to exactly one.
ALTER TABLE crm_users DROP CONSTRAINT IF EXISTS crm_users_role_domain_check;
ALTER TABLE crm_users ADD CONSTRAINT crm_users_role_domain_check
    CHECK ((role = 'super_admin') = (domain IS NULL));

CREATE INDEX IF NOT EXISTS crm_users_domain_idx ON crm_users (domain);
