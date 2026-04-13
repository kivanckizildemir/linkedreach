-- Microsoft OAuth connections for Teams meeting scheduler
-- One row per user — links their Microsoft account to LinkedReach

CREATE TABLE IF NOT EXISTS microsoft_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ms_email      TEXT NOT NULL,
  ms_user_id    TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT microsoft_connections_user_id_key UNIQUE (user_id)
);

-- RLS: users only see their own connection
ALTER TABLE microsoft_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own Microsoft connection"
  ON microsoft_connections
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_microsoft_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER microsoft_connections_updated_at
  BEFORE UPDATE ON microsoft_connections
  FOR EACH ROW EXECUTE FUNCTION update_microsoft_connections_updated_at();
