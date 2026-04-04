-- Add debug_log column to linkedin_accounts for storing login debug snapshots
-- Used by the /api/login-debug endpoint to diagnose BrightData Scraping Browser issues
alter table linkedin_accounts
  add column if not exists debug_log jsonb default null;
