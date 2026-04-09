-- Migration 00026: Extend sender profile on linkedin_accounts
-- Add the same enrichment fields collected for leads so AI can write
-- truly personalised messages FROM the sender's perspective.

ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS sender_skills        text[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sender_experience    text,
  ADD COLUMN IF NOT EXISTS sender_recent_posts  text[]   DEFAULT '{}';
