-- Add unique constraint on leads.linkedin_url so upsert ON CONFLICT works
ALTER TABLE leads ADD CONSTRAINT leads_linkedin_url_key UNIQUE (linkedin_url);
