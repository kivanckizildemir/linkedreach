-- Replace single lead_priority enum with two independent boolean toggles.
-- Migrate existing high_icp flag → priority_high_icp = true.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS priority_high_icp  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority_warm_leads boolean NOT NULL DEFAULT false;

-- Preserve existing high_icp selections
UPDATE campaigns
SET priority_high_icp = true
WHERE lead_priority = 'high_icp';
