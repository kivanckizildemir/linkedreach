-- Migration: 00028_engagement_score
-- Adds engagement scoring fields to campaign_leads
-- Replaces campaign_fit_score with a behavioural warmth score driven by Claude

ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS engagement_score        smallint CHECK (engagement_score >= 0 AND engagement_score <= 100),
  ADD COLUMN IF NOT EXISTS previous_engagement_score smallint CHECK (previous_engagement_score >= 0 AND previous_engagement_score <= 100),
  ADD COLUMN IF NOT EXISTS engagement_trend        text CHECK (engagement_trend IN ('up', 'down', 'stable')),
  ADD COLUMN IF NOT EXISTS engagement_reasoning    text,
  ADD COLUMN IF NOT EXISTS engagement_events       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS engagement_updated_at   timestamptz;
