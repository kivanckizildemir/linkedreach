-- Allow 'linkedin_search' as a valid source for lead_lists
ALTER TABLE lead_lists
  DROP CONSTRAINT IF EXISTS lead_lists_source_check;

ALTER TABLE lead_lists
  ADD CONSTRAINT lead_lists_source_check
  CHECK (source IN ('sales_nav', 'excel', 'manual', 'chrome_extension', 'linkedin_search'));
