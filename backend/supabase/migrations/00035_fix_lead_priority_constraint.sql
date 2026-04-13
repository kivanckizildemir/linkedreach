-- Fix lead_priority check constraint.
--
-- Migration 00030 created lead_priority with CHECK IN ('high_icp','low_icp','fifo').
-- The app needs to store 'warm' and 'high_icp+warm' as well, and NULL (= no priority / FIFO).
-- Migration 00034 intended to move to boolean columns but the code was never updated to match;
-- the string-based lead_priority column is still the live field — fix the constraint here.

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_lead_priority_check;

-- Allow NULL (no priority selected = neutral FIFO ordering)
ALTER TABLE campaigns
  ALTER COLUMN lead_priority DROP NOT NULL,
  ALTER COLUMN lead_priority SET DEFAULT NULL;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_lead_priority_check
  CHECK (lead_priority IS NULL OR lead_priority IN ('high_icp', 'warm', 'high_icp+warm', 'low_icp', 'fifo'));

-- Add composite index to speed up daily-limit queries on activity_log
CREATE INDEX IF NOT EXISTS idx_activity_log_account_action_date
  ON activity_log (account_id, action, created_at);
