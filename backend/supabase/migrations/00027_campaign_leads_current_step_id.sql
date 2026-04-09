-- Track exactly which sequence step node a lead is currently on.
-- Needed for per-node lead indicators in the flow canvas UI.
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS current_step_id uuid
    REFERENCES sequence_steps(id) ON DELETE SET NULL;
