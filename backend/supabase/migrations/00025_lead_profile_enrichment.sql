-- Profile enrichment fields on leads (scraped during Sales Nav / LinkedIn scrape)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS about               text,
  ADD COLUMN IF NOT EXISTS experience_description text,
  ADD COLUMN IF NOT EXISTS skills              text[],
  ADD COLUMN IF NOT EXISTS recent_posts        text[];

-- Sender identity on the LinkedIn account (scraped after login)
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS sender_name     text,
  ADD COLUMN IF NOT EXISTS sender_headline text,
  ADD COLUMN IF NOT EXISTS sender_about    text;
