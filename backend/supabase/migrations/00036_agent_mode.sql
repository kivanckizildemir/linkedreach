-- Agent Mode: structured reply agent for campaigns
-- Adds agent settings to campaigns and warmth tracking to campaign_leads

-- ── campaigns: agent_mode_settings ───────────────────────────────────────────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS agent_mode_settings JSONB DEFAULT NULL;

COMMENT ON COLUMN campaigns.agent_mode_settings IS
  'Agent mode config: enabled, match_tone, match_length, match_approach,
   reply_delay_minutes {min,max}, meeting_scheduler_enabled, meeting_type,
   meeting_platform, meeting_link, meeting_duration_minutes,
   warmth_threshold_for_meeting, not_interested_action,
   sender_location, f2f_location_mode, f2f_locations';

-- ── campaign_leads: warmth tracking ──────────────────────────────────────────
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS warmth_score      INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS warmth_flag       VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS agent_mode_active BOOLEAN DEFAULT FALSE NOT NULL;

ALTER TABLE campaign_leads
  ADD CONSTRAINT campaign_leads_warmth_flag_check
    CHECK (warmth_flag IS NULL OR warmth_flag IN (
      'hot', 'warm', 'neutral', 'cold', 'objection', 'not_interested'
    ));

-- Index for agent queue queries
CREATE INDEX IF NOT EXISTS idx_campaign_leads_agent_mode
  ON campaign_leads (agent_mode_active, status)
  WHERE agent_mode_active = TRUE;
