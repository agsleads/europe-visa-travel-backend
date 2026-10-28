-- Facebook Lead Ads become a second way enquiries arrive.
--
-- A Facebook Instant Form lead is stored as an ordinary enquiry with
-- source = 'facebook', so it is worked in the CRM exactly like a website
-- enquiry: same pipeline, assignment, notes and follow-ups.

-- 1. Email becomes optional. An advertiser chooses the form's questions and a
--    phone-only form is common; rejecting those leads would lose them outright.
--    The shape check still applies whenever an email is present (a CHECK on a
--    NULL passes).
ALTER TABLE enquiries ALTER COLUMN email DROP NOT NULL;

-- 2. The producer's own id for the lead (Meta's leadgen id), so a lead that is
--    delivered twice -- a webhook retry, or an import of leads already received
--    -- is stored once. Unique per source: ids are only unique within the
--    system that issued them.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS external_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS enquiries_source_external_id_key
    ON enquiries (source, external_id)
 WHERE external_id IS NOT NULL;

-- 3. What the producer told us about the lead beyond the core contact fields:
--    for Facebook, the page, form, ad and campaign ids and every form answer.
--    JSONB because each advertiser's form asks different questions.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS lead_details JSONB;

-- 4. The CRM filters by source.
CREATE INDEX IF NOT EXISTS enquiries_source_created_at_idx
    ON enquiries (source, created_at DESC);
