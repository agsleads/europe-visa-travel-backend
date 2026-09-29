-- The Final Expense form never asks for a coverage amount, so the column can
-- never be filled, and NOT NULL made every lead from the site fail to save.
-- Dropping it also drops final_expense_leads_coverage_check. Any value a caller
-- did send is still preserved in raw_payload.
ALTER TABLE final_expense_leads
    DROP COLUMN IF EXISTS coverage_amount;
