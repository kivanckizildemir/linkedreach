-- Lead lists: named containers for leads (like HeyReach)
CREATE TABLE lead_lists (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  source      text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('sales_nav', 'excel', 'manual', 'chrome_extension')),
  search_url  text,            -- original Sales Nav URL (for reference / re-scrape)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lead_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own lead lists"
  ON lead_lists FOR ALL USING (auth.uid() = user_id);

-- Link leads to a list (nullable — existing leads have no list)
ALTER TABLE leads ADD COLUMN list_id uuid REFERENCES lead_lists(id) ON DELETE SET NULL;
CREATE INDEX leads_list_id_idx ON leads (list_id);
