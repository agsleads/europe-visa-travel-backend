-- Jornaya LeadiD for Final Expense Coverage leads.
--
-- The LeadiD is the 36-character token Jornaya's script writes into the form in
-- the visitor's browser (campaign "finalexpensecoverage"). Jornaya holds the
-- recording of what the visitor saw and did; this column is the key that ties
-- that recording, and so the TCPA consent proof, to the lead.
--
-- Nullable, and not constrained beyond its length: tracking must never cost us a
-- lead. A visitor with an ad blocker sends no token, and a malformed one is
-- stored as NULL by the API. Leads that pre-date this column are NULL too.
--
-- Kept on final_expense_leads rather than the append-only consent table: it is
-- attached at intake and never changes, but it is looked up per lead, and the
-- verbatim value the browser sent is preserved in raw_payload regardless.
ALTER TABLE final_expense_leads
    ADD COLUMN IF NOT EXISTS universal_leadid VARCHAR(36);

-- Support asks "which lead is this LeadiD?" when Jornaya flags one. Partial: most
-- historic rows are NULL, and NULLs are never looked up.
CREATE INDEX IF NOT EXISTS final_expense_leads_universal_leadid_idx
    ON final_expense_leads (universal_leadid)
    WHERE universal_leadid IS NOT NULL;
