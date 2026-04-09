-- Campaign target audience: free-text description of who this campaign targets.
-- Separate from ICP (which is account-wide); this is campaign-specific.
alter table campaigns add column if not exists target_audience text;

-- Per-campaign-lead fit score: how well this lead matches this specific campaign's
-- target audience, scored 0-100 by AI. Separate from icp_score (account-wide ICP).
alter table campaign_leads add column if not exists campaign_fit_score smallint;
alter table campaign_leads add column if not exists campaign_fit_reasoning text;
