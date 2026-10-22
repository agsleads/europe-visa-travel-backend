-- The CRM's own status list replaces the generic six-stage pipeline.
--
-- Existing rows map onto the nearest new status:
--   contacted -> conversation_ongoing   qualified -> interested
--   proposal  -> awaiting_payment       converted -> closed
--   lost      -> not_interested         new       -> new
--
-- For reporting, each status belongs to a group (open, on hold, won, lost);
-- that grouping lives in src/domain/enquiry.schema.ts.

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_status_check;

UPDATE enquiries SET status = CASE status
    WHEN 'contacted' THEN 'conversation_ongoing'
    WHEN 'qualified' THEN 'interested'
    WHEN 'proposal'  THEN 'awaiting_payment'
    WHEN 'converted' THEN 'closed'
    WHEN 'lost'      THEN 'not_interested'
    ELSE status
END
WHERE status IN ('contacted', 'qualified', 'proposal', 'converted', 'lost');

ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_check CHECK (status IN (
    'new', 'no_response', 'follow_up_required', 'conversation_ongoing', 'call_scheduled',
    'call_rescheduled', 'interested', 'documents_pending', 'awaiting_payment', 'pre_closed',
    'travel_date_deferred', 'closed',
    'visa_shopping', 'irrelevant_inquiry', 'not_eligible', 'not_interested', 'duplicate_lead'
));

-- Status VARCHAR(20) is too short for the longest key ("travel_date_deferred" is 20,
-- "conversation_ongoing" is 20); widen it so future names have room.
ALTER TABLE enquiries ALTER COLUMN status TYPE VARCHAR(30);
