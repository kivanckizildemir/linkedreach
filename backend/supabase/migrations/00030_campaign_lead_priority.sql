-- Add lead_priority setting to campaigns
-- Controls the order in which leads are processed by the sequence runner.
-- 'high_icp'  → process highest ICP score leads first (default)
-- 'low_icp'   → process lowest ICP score leads first
-- 'fifo'      → process in the order leads were added (no ICP ordering)

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS lead_priority text NOT NULL DEFAULT 'high_icp'
    CHECK (lead_priority IN ('high_icp', 'low_icp', 'fifo'));
